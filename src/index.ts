import {
  getAgentDir, type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverAgents, loadAgent } from "./agents.ts";
import { CompletionOutbox, type Completion } from "./completion.ts";
import { Controller, type Worker } from "./controller.ts";
import {
  ENTRY, PREVIEW_LENGTH, active, reconstruct, resultPath,
  type ParentEntry, type WorkerResult,
} from "./state.ts";

const Thinking = Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => Type.Literal(value)));

function response(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function describe(worker: Worker): string {
  const status = worker.connection === "connected" ? worker.state?.status ?? "starting" : worker.connection;
  return `${worker.manifest.name} (${worker.reference.id}): ${status}${worker.error ? `\n${worker.error}` : ""}`;
}

function resultText(result: WorkerResult, limit = PREVIEW_LENGTH): string {
  return `${result.outcome}${result.error ? `: ${result.error}` : ""}\n\n${result.text.slice(0, limit)}${
    result.text.length > limit ? `\n\n[Preview truncated. Full output is in ${result.sessionFile ?? "the worker transcript"}.]` : ""
  }`;
}

export default function rexSubagents(pi: ExtensionAPI): void {
  if (process.env.PI_REX_WORKER) return;

  let controller: Controller | undefined;
  let consumed = new Map<string, number>();
  let outbox: CompletionOutbox | undefined;
  const sent = new Map<string, Completion>();
  let generation = 0;

  const consume = (id: string, revision: number) => {
    if (revision <= (consumed.get(id) ?? 0)) return;
    consumed.set(id, revision);
    if ((sent.get(id)?.revision ?? Infinity) <= revision) sent.delete(id);
    outbox?.consume(id, revision);
    pi.appendEntry<ParentEntry>(ENTRY, { action: "consumed", id, revision });
  };

  const stop = () => {
    generation++;
    outbox?.dispose();
    controller?.dispose();
    controller = undefined;
    sent.clear();
  };

  const start = (ctx: ExtensionContext) => {
    stop();
    const currentGeneration = generation;
    const restored = reconstruct(ctx.sessionManager.getBranch());
    consumed = restored.consumed;
    outbox = new CompletionOutbox(() => !ctx.isIdle(), (items) => {
      if (generation !== currentGeneration) return;
      for (const item of items) sent.set(item.id, item);
      pi.sendMessage({
        customType: "rex-subagent-result",
        content: items.map((item) => item.content).join("\n\n"),
        display: true,
        details: { workers: items.map(({ id, revision }) => ({ id, revision })) },
      }, { deliverAs: "steer", triggerTurn: true });
    });
    const location = process.env.REX_SESSION && process.env.REX_BLOCK ? {
      server: process.env.REX_SERVER,
      session: process.env.REX_SESSION,
      parentBlock: process.env.REX_BLOCK,
    } : undefined;
    controller = new Controller(ctx.sessionManager.getSessionId(), location,
      (worker) => pi.appendEntry<ParentEntry>(ENTRY, { action: "worker", worker }),
      (worker) => {
        if (generation !== currentGeneration) return;
        if (worker.error && !controller?.workers.has(worker.reference.id)) ctx.ui.notify(worker.error, "warning");
        if (worker.manifest.stopped) {
          outbox?.consume(worker.reference.id, Infinity);
          sent.delete(worker.reference.id);
          if (worker.connection === "closed") {
            consume(worker.reference.id, Math.max(worker.state?.run ?? 0, worker.state?.resultRevision ?? 0));
          }
        }
        const result = worker.manifest.stopped ? undefined : controller?.result(worker);
        const known = Math.max(consumed.get(worker.reference.id) ?? 0, sent.get(worker.reference.id)?.revision ?? 0);
        if (result && result.revision > known) {
          outbox?.add({
            id: worker.reference.id, revision: result.revision,
            content: `Worker ${worker.manifest.name} (${worker.reference.id}), result ${result.revision}:\n${resultText(result)}`,
          });
        }
        if (!worker.manifest.stopped && worker.connection === "closed" && worker.state && active(worker.state.status)
          && worker.state.run > known) {
          outbox?.add({
            id: worker.reference.id, revision: worker.state.run,
            content: `Worker ${worker.manifest.name} (${worker.reference.id}) was interrupted before run ${worker.state.run} settled. ${
              worker.error ?? ""
            }\nTranscript: ${worker.state.sessionFile ?? worker.reference.directory}`,
          });
        }
        const workers = [...(controller?.workers.values() ?? [])];
        const working = workers.filter((item) => item.connection !== "closed" && (!item.state || active(item.state.status))).length;
        const open = workers.filter((item) => item.connection !== "closed").length;
        ctx.ui.setStatus(ENTRY, open ? `${working} working / ${open} workers` : undefined);
      });
    controller.attach(restored.workers);
  };

  pi.on("session_start", (_event, ctx) => start(ctx));
  pi.on("session_tree", (_event, ctx) => start(ctx));
  pi.on("session_shutdown", () => stop());
  pi.on("turn_end", (event) => outbox?.boundary(event.outcome !== "completed"));
  pi.on("message_end", (event) => {
    if (event.message.role !== "custom" || event.message.customType !== "rex-subagent-result") return;
    const details = event.message.details as { workers?: { id: string; revision: number }[] } | undefined;
    for (const item of details?.workers ?? []) consume(item.id, item.revision);
  });
  pi.on("agent_settled", () => {
    // Esc can clear a steering notification before it enters the transcript.
    // Consume only persisted messages and put undelivered revisions back.
    for (const item of sent.values()) outbox?.add(item);
    sent.clear();
    outbox?.settled();
  });

  const current = (): Controller => {
    if (!controller) throw new Error("Rex subagents are unavailable until a Pi session starts");
    return controller;
  };

  const available = [...discoverAgents()].map(([name, agent]) => `${name}: ${agent.description}`).join("; ");
  pi.registerTool({
    name: "spawn_subagent",
    label: "Rex worker",
    description: `Delegate a self-contained assignment to an interactive Pi worker in a minimized Rex pane. Workers run in the background and notify you on completion. The user can open a pane and chat or steer naturally. Use only when the user requests or agrees to delegation. Available agents: ${available || "none"}. Shared checkout by default; assignments must define scope and preserve other changes. Workers keep running when the parent turn is cancelled. Do not poll or invent pending results.`,
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, description: "Self-contained assignment, including scope and required checks" }),
      description: Type.String({ minLength: 1, description: "Short task label" }),
      subagent_type: Type.Optional(Type.String({ description: "Agent definition name; required for a new worker" })),
      name: Type.Optional(Type.String({ description: "Unique memorable worker name" })),
      model: Type.Optional(Type.String({ description: "Model ID, provider/modelId, or unambiguous name match" })),
      thinking: Type.Optional(Thinking),
      cwd: Type.Optional(Type.String({ description: "Worker checkout directory; defaults to the parent's cwd" })),
      context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
        default: "fresh",
        description: "New workers only: fresh starts with the assignment; fork copies the parent's active conversation branch at spawn time.",
      })),
      resume: Type.Optional(Type.String({ description: "ID or name of an idle or closed worker to continue" })),
      run_in_background: Type.Optional(Type.Boolean({ default: true, description: "False waits for the result. Cancelling a wait leaves the worker running." })),
    }),
    async execute(_callId, params, signal, _update, ctx) {
      const manager = current();
      let worker: Worker;
      if (params.resume) {
        if (params.model || params.thinking || params.cwd || params.subagent_type || params.name || params.context !== undefined) {
          throw new Error("Resume keeps the worker's existing configuration. Change model or thinking in its native Pi pane.");
        }
        worker = await manager.resume(manager.find(params.resume), params.prompt);
      } else {
        if (!params.subagent_type) throw new Error("subagent_type is required for a new worker");
        const agent = loadAgent(params.subagent_type);
        const pattern = params.model ?? agent.model;
        let model = ctx.model;
        if (pattern) {
          const models = ctx.modelRegistry.getAvailable();
          const exact = models.filter((candidate) => `${candidate.provider}/${candidate.id}` === pattern || candidate.id === pattern);
          const matches = exact.length ? exact : models.filter((candidate) =>
            `${candidate.provider}/${candidate.id} ${candidate.name}`.toLowerCase().includes(pattern.toLowerCase()));
          if (matches.length !== 1) throw new Error(`Model "${pattern}" ${matches.length ? "is ambiguous" : "is unavailable"}. Use provider/modelId.`);
          model = matches[0];
        }
        if (!model) throw new Error("Choose a model before launching a worker");
        worker = await manager.spawn({
          prompt: params.prompt, description: params.description, name: params.name,
          cwd: params.cwd ?? ctx.cwd, agent, model: `${model.provider}/${model.id}`,
          thinking: params.thinking ?? agent.thinking ?? pi.getThinkingLevel(),
          agentDir: getAgentDir(),
          fork: params.context === "fork" ? {
            entries: structuredClone(ctx.sessionManager.getBranch()),
            parentSession: ctx.sessionManager.getSessionFile(),
          } : undefined,
        });
      }
      if (params.run_in_background === false) {
        const result = await manager.wait(worker, signal);
        if (result) consume(worker.reference.id, result.revision);
        return response(result ? resultText(result, 50 * 1024) : describe(worker), { worker: worker.reference, result });
      }
      return response(`${describe(worker)}\nOpen its pane in Rex. Completion will be delivered automatically.`, {
        worker: worker.reference, pane: worker.pane,
      });
    },
  });

  pi.registerTool({
    name: "get_subagent_result",
    label: "Worker result",
    description: "Retrieve a worker's latest result or wait for its current run. Use the ID or name returned by spawn_subagent. Cancelling a wait leaves the worker running.",
    parameters: Type.Object({
      agent_id: Type.String(),
      wait: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_callId, params, signal) {
      const manager = current();
      const worker = manager.find(params.agent_id);
      const result = params.wait ? await manager.wait(worker, signal) : manager.result(worker);
      if (result) consume(worker.reference.id, result.revision);
      return response(`${describe(worker)}${result ? `\n\nResult ${result.revision}: ${resultText(result, 50 * 1024)}\n\nFull result file: ${
        resultPath(worker.reference.directory, result.revision)
      }` : ""}`, {
        worker: worker.reference, state: worker.state, connection: worker.connection, result,
      });
    },
  });

  pi.registerTool({
    name: "stop_subagent",
    label: "Stop worker",
    description: "Hard-stop a worker and its child processes. Keeps its Rex pane available for reading terminal output. Returns only a stop acknowledgement; suppresses completion notifications. Use the worker's ID or name.",
    parameters: Type.Object({ agent_id: Type.String() }),
    async execute(_callId, params) {
      const manager = current();
      const worker = manager.find(params.agent_id);
      await manager.stop(worker);
      return response(`Stopped ${worker.manifest.name}.`, { worker: worker.reference, pane: worker.pane });
    },
  });

  pi.registerTool({
    name: "steer_subagent",
    label: "Steer worker",
    description: "Send directions to a connected worker through Pi's native steering queue, preserving any draft in its editor. Acknowledgement means accepted; wait for the eventual result.",
    parameters: Type.Object({ agent_id: Type.String(), message: Type.String({ minLength: 1 }) }),
    async execute(_callId, params) {
      const worker = current().find(params.agent_id);
      await current().steer(worker, params.message);
      return response(`Directions accepted by ${worker.manifest.name}.`, { worker: worker.reference });
    },
  });
}
