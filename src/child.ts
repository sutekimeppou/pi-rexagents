import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  acquireLock, active, loadManifest, readJson, resultPath, writeJson,
  type Manifest, type WorkerResult, type WorkerState,
} from "./state.ts";
import { BridgeServer } from "./transport.ts";

export function finishRun(
  state: WorkerState,
  entries: readonly { id: string; type: string; message?: unknown }[],
  aborted: boolean,
  leafId: string | null,
): WorkerResult {
  const boundary = state.runStartLeaf ? entries.findIndex((entry) => entry.id === state.runStartLeaf) : -1;
  const messages = entries.slice(boundary + 1).filter((entry) => entry.type === "message")
    .map((entry) => entry.message as {
      role: string; stopReason?: string; errorMessage?: string;
      content?: { type: string; text?: string }[];
    });
  const assistant = messages.findLast((message) => message.role === "assistant");
  const failure = assistant?.stopReason === "error" || assistant?.stopReason === "length";
  return {
    id: state.id,
    revision: state.run,
    reportToParent: state.reportToParent !== false,
    outcome: aborted || assistant?.stopReason === "aborted" ? "aborted" : failure || !assistant ? "error" : "completed",
    text: assistant?.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "",
    error: aborted ? "Worker run was interrupted"
      : failure ? assistant?.errorMessage || `Worker stopped with ${assistant?.stopReason}`
      : !assistant ? "Worker settled before producing an assistant response" : undefined,
    sessionFile: state.sessionFile,
    leafId,
    completedAt: new Date().toISOString(),
  };
}

export default function childBridge(pi: ExtensionAPI): void {
  const manifestFile = process.env.PI_REX_WORKER;
  if (!manifestFile) return;
  let manifest: Manifest;
  let state: WorkerState;
  let context: ExtensionContext;
  let bridge: BridgeServer | undefined;
  let release: (() => void) | undefined;
  let ready = false;

  const publish = () => {
    state.updatedAt = new Date().toISOString();
    state.sessionFile = context.sessionManager.getSessionFile();
    state.model = context.model ? `${context.model.provider}/${context.model.id}` : manifest.model;
    state.thinking = pi.getThinkingLevel();
    writeJson(join(manifest.directory, "state.json"), state);
    bridge?.publish();
  };

  const begin = () => {
    if (!active(state.status)) {
      state.run++;
      state.runStartLeaf = context.sessionManager.getLeafId();
      state.reportToParent = false;
    }
    state.status = "running";
    state.error = undefined;
    publish();
  };

  const settle = (aborted: boolean) => {
    if (!active(state.status)) return;
    const result = finishRun(state, context.sessionManager.getBranch(), aborted, context.sessionManager.getLeafId());
    writeJson(resultPath(manifest.directory, result.revision), result);
    state.resultRevision = result.revision;
    if (result.reportToParent) state.parentResultRevision = result.revision;
    state.status = result.outcome;
    state.error = result.error;
    publish();
  };

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    try {
      manifest = loadManifest(dirname(manifestFile));
      if (ctx.mode !== "tui" || ctx.sessionManager.getSessionId() !== manifest.sessionId) {
        throw new Error("Rex worker must run interactively in its assigned Pi session");
      }
      release = acquireLock(join(manifest.directory, "owner.json"));
      const previous = readJson<WorkerState>(join(manifest.directory, "state.json"));
      const sameInstance = previous?.instance === manifest.instance;
      const initialPrompt = !sameInstance && manifest.initialPrompt
        ? readFileSync(manifest.initialPrompt, "utf8") : undefined;
      state = sameInstance ? { ...previous } : {
        version: 1, id: manifest.id, instance: manifest.instance,
        pid: process.pid, run: previous?.run ?? 0, resultRevision: previous?.resultRevision ?? 0,
        parentResultRevision: previous?.parentResultRevision ?? previous?.resultRevision ?? 0,
        reportToParent: false,
        suppressedRevision: previous?.suppressedRevision,
        status: "idle", runStartLeaf: ctx.sessionManager.getLeafId(), updatedAt: new Date().toISOString(),
      };
      state.pid = process.pid;
      state.block = process.env.REX_BLOCK;
      state.parentResultRevision ??= state.resultRevision;
      if (initialPrompt !== undefined) {
        state.run++;
        state.status = "starting";
        state.reportToParent = true;
      }
      // Exclusive process ownership is established before removing a stale socket.
      rmSync(manifest.socketPath, { force: true });
      bridge = new BridgeServer(manifest.socketPath, () => state, (input) => {
        if (input.method === "stop") {
          // Suppress only this run. The user can continue chatting in the same pane.
          state.suppressedRevision = state.run;
          publish();
          ctx.abort();
        } else if (input.method === "steer") {
          // Reserve the next revision synchronously so a following wait sees it.
          // Pi can already be busy before our start hook runs.
          if (!active(state.status)) {
            state.run++;
            state.runStartLeaf = ctx.sessionManager.getLeafId();
            state.status = "starting";
          }
          state.reportToParent = true;
          publish();
          pi.sendUserMessage(input.message!, { deliverAs: "steer" });
        }
        return { accepted: true, run: state.run };
      });
      await bridge.listen();
      ready = true;
      publish();
      if (initialPrompt !== undefined) pi.sendUserMessage(initialPrompt);
    } catch (error) {
      ctx.ui.notify(`Rex worker startup failed: ${error instanceof Error ? error.message : error}`, "error");
      ctx.shutdown();
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!ready) {
      ctx.abort();
      throw new Error("Rex worker bridge is unavailable");
    }
    begin();
  });
  pi.on("agent_start", () => { if (ready) begin(); });
  pi.on("agent_settled", (event) => { if (ready) settle(event.aborted); });
  pi.on("ui_prompt_start", () => {
    if (ready && active(state.status)) { state.status = "blocked"; publish(); }
  });
  pi.on("ui_prompt_end", () => {
    if (ready && state.status === "blocked") { state.status = "running"; publish(); }
  });
  pi.on("session_info_changed", () => { if (ready) publish(); });
  pi.on("model_select", (_event, ctx) => { context = ctx; if (ready) publish(); });
  pi.on("thinking_level_select", (_event, ctx) => { context = ctx; if (ready) publish(); });

  const keepSession = (_event: unknown, ctx: ExtensionContext) => {
    ctx.ui.notify("This pane belongs to a delegated worker. Open a separate Pi pane for another session.", "warning");
    return { cancel: true };
  };
  pi.on("session_before_switch", keepSession);
  pi.on("session_before_fork", keepSession);

  pi.on("session_shutdown", async (event) => {
    ready = false;
    try {
      if (state && release && event.reason !== "reload") {
        settle(true);
        state.status = "closed";
        publish();
      }
    } finally {
      await bridge?.close();
      bridge = undefined;
      release?.();
      release = undefined;
    }
  });
}
