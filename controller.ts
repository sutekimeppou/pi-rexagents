import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  acquireLock, active, isAlive, loadManifest, MAX_OPEN_WORKERS, piInvocation,
  readJson, resultPath, stateRoot, writeJson, writePrivate,
  type AgentDefinition, type ForkContext, type Manifest, type Pane, type WorkerReference, type WorkerResult, type WorkerState,
} from "./state.ts";
import { BridgeClient } from "./transport.ts";
import { Rex } from "./rex.ts";

export interface Worker {
  reference: WorkerReference;
  manifest: Manifest;
  pane?: Pane;
  state?: WorkerState;
  connection: "connecting" | "connected" | "disconnected" | "closed";
  error?: string;
  client?: BridgeClient;
  retry?: ReturnType<typeof setTimeout>;
}

interface LaunchOptions {
  prompt: string;
  description: string;
  name?: string;
  cwd: string;
  agent: AgentDefinition;
  model: string;
  thinking: string;
  agentDir: string;
  fork?: ForkContext;
}

export class Controller {
  readonly workers = new Map<string, Worker>();
  private disposed = false;
  private launchQueue: Promise<unknown> = Promise.resolve();
  private stops: (() => void)[] = [];

  constructor(
    private parentId: string,
    private location: Manifest["rex"] | undefined,
    private onWorker: (reference: WorkerReference) => void,
    private onChange: (worker: Worker) => void,
    private maxOpen = MAX_OPEN_WORKERS,
  ) {}

  attach(references: WorkerReference[]): void {
    const locations = new Set<string>();
    for (const reference of references) {
      try {
        const worker = this.add(reference);
        this.connect(worker);
        const key = JSON.stringify(worker.manifest.rex);
        if (!locations.has(key)) {
          locations.add(key);
          this.stops.push(new Rex(worker.manifest.rex).watch(() => {
            for (const candidate of this.workers.values()) {
              if (candidate.connection === "disconnected") this.schedule(candidate, 250);
            }
          }));
        }
      } catch (error) {
        // A missing/corrupt manifest should not prevent restoring other workers.
        this.onChange({
          reference, manifest: { id: reference.id, name: reference.id } as Manifest,
          connection: "closed", error: String(error),
        });
      }
    }
  }

  private add(reference: WorkerReference): Worker {
    const manifest = loadManifest(reference.directory);
    if (manifest.id !== reference.id || manifest.parentSessionId !== this.parentId) {
      throw new Error("Worker does not belong to this parent session");
    }
    const state = readJson<WorkerState>(join(reference.directory, "state.json"));
    const worker: Worker = {
      reference, manifest,
      pane: readJson<Pane>(join(reference.directory, "pane.json")),
      state: state?.instance === manifest.instance ? state : undefined,
      connection: "connecting",
    };
    this.workers.set(reference.id, worker);
    return worker;
  }

  find(id: string): Worker {
    const matches = [...this.workers.values()].filter((worker) => worker.reference.id === id || worker.manifest.name === id);
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous worker name "${id}"; use its ID` : `Unknown worker "${id}"`);
    return matches[0];
  }

  private changed(worker: Worker): void {
    if (!this.disposed) this.onChange(worker);
  }

  private receive(worker: Worker, value: unknown): void {
    const state = value as WorkerState;
    if (!state || state.version !== 1 || state.id !== worker.manifest.id || state.instance !== worker.manifest.instance
      || !Number.isSafeInteger(state.run) || !Number.isSafeInteger(state.resultRevision)) {
      throw new Error("Worker bridge identity or state is invalid");
    }
    worker.state = state;
    worker.connection = state.status === "closed" ? "closed" : "connected";
    worker.error = undefined;
    if (state.block) worker.pane = { ...worker.pane, instance: state.instance, block: state.block };
    this.changed(worker);
  }

  private connect(worker: Worker): void {
    if (this.disposed) return;
    worker.client?.close();
    worker.connection = "connecting";
    const client = new BridgeClient(worker.manifest.socketPath, (state) => this.receive(worker, state), () => {
      if (worker.client !== client || this.disposed) return;
      worker.client = undefined;
      if (worker.state?.status === "closed") {
        worker.connection = "closed";
        this.changed(worker);
        return;
      }
      worker.connection = "disconnected";
      this.changed(worker);
      this.schedule(worker, 500);
    });
    worker.client = client;
    void client.call("subscribe").then((state) => {
      if (!this.disposed && worker.client === client) this.receive(worker, state);
    }).catch(() => {
      if (worker.client === client) client.close();
      if (!this.disposed && worker.client === client) {
        worker.client = undefined;
        worker.connection = "disconnected";
        this.schedule(worker, 500);
      }
    });
  }

  private schedule(worker: Worker, milliseconds = 2_000): void {
    if (this.disposed || worker.retry) return;
    worker.retry = setTimeout(() => {
      worker.retry = undefined;
      void this.reconcile(worker).catch((error) => {
        worker.error = `Could not inspect Rex: ${error instanceof Error ? error.message : error}`;
        this.changed(worker);
        this.schedule(worker, 5_000);
      });
    }, milliseconds);
    worker.retry.unref();
  }

  async reconcile(worker: Worker): Promise<void> {
    if (this.disposed || worker.connection === "connected") return;
    const rex = new Rex(worker.manifest.rex);
    worker.pane ??= await rex.recover(worker.manifest);
    const running = worker.pane && await rex.running(worker.pane.block);
    if (this.disposed) return;
    if (!running) {
      worker.state = readJson<WorkerState>(join(worker.reference.directory, "state.json")) ?? worker.state;
      worker.connection = "closed";
      worker.error = worker.state && active(worker.state.status) ? "Worker exited before its current run settled"
        : !worker.state ? "Worker exited before its bridge became available. Open its pane to read startup diagnostics."
        : undefined;
      this.changed(worker);
      return;
    }
    this.connect(worker);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.launchQueue.then(() => {
      if (this.disposed) throw new Error("The parent extension has shut down");
      return operation();
    });
    this.launchQueue = next.catch(() => {});
    return next;
  }

  async spawn(options: LaunchOptions): Promise<Worker> {
    return this.serial(async () => {
      if (!this.location) throw new Error("Launch Pi inside Rex to create worker panes");
      const cwd = resolve(options.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error(`Worker cwd is not a directory: ${cwd}`);
      if (options.name && [...this.workers.values()].some((worker) => worker.manifest.name === options.name)) {
        throw new Error(`Worker name "${options.name}" is already in use`);
      }
      this.capacity();
      await new Rex(this.location).check();
      this.assertLive();
      const id = randomUUID();
      const directory = join(stateRoot(), encodeURIComponent(this.parentId), id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const runtime = mkdtempSync("/tmp/pi-rex-");
      const manifest: Manifest = {
        version: 1, id, instance: randomUUID(),
        name: options.name || `${options.agent.name}-${id.slice(0, 6)}`,
        description: options.description,
        parentSessionId: this.parentId, sessionId: randomUUID(), agentDir: options.agentDir, cwd, directory,
        socketPath: join(runtime, "worker.sock"), rex: this.location,
        agent: options.agent, model: options.model, thinking: options.thinking,
        context: options.fork ? "fork" : "fresh",
        initialPrompt: join(directory, "assignment.md"),
      };
      if (options.fork) {
        // Seed a separate native transcript from the captured active branch.
        // Pi handles compaction, context edits, and unfinished historical tool calls.
        const session = SessionManager.create(cwd, join(directory, "sessions"), {
          id: manifest.sessionId, parentSession: options.fork.parentSession,
        });
        writePrivate(session.getSessionFile()!, [session.getHeader(), ...options.fork.entries]
          .map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      }
      writePrivate(manifest.initialPrompt!, options.prompt);
      writePrivate(join(directory, "agent-prompt.md"), manifest.agent.prompt);
      writeJson(join(directory, "launch.json"), manifest);
      const reference = { id, directory };
      this.onWorker(reference);
      const worker = this.add(reference);
      await this.launch(worker);
      return worker;
    });
  }

  private capacity(): void {
    const open = [...this.workers.values()].filter((worker) => worker.connection !== "closed").length;
    if (open >= this.maxOpen) throw new Error(`There are already ${this.maxOpen} open workers. Close one through /agents first.`);
  }

  private command(manifest: Manifest): string[] {
    const args = [
      "--session-id", manifest.sessionId,
      "--session-dir", join(manifest.directory, "sessions"),
      "--name", `${manifest.agent.name}: ${manifest.description}`,
      "--extension", fileURLToPath(new URL("./child.ts", import.meta.url)),
      "--append-system-prompt", join(manifest.directory, "agent-prompt.md"),
      "--model", manifest.model, "--thinking", manifest.thinking,
    ];
    if (!manifest.agent.extensions) args.push("--no-extensions");
    if (!manifest.agent.skills) args.push("--no-skills");
    if (manifest.agent.tools) {
      if (manifest.agent.tools.length) args.push("--tools", manifest.agent.tools.join(","));
      else args.push("--no-tools");
    }
    if (manifest.initialPrompt) args.push("--", `@${manifest.initialPrompt}`);
    return [
      "/usr/bin/env",
      `PI_REX_WORKER=${join(manifest.directory, "launch.json")}`,
      `PI_CODING_AGENT_DIR=${manifest.agentDir}`,
      ...(process.env.PI_OFFLINE ? [`PI_OFFLINE=${process.env.PI_OFFLINE}`] : []),
      ...piInvocation(args),
    ];
  }

  private async launch(worker: Worker): Promise<void> {
    const release = acquireLock(join(worker.reference.directory, "launch-lock.json"));
    try {
      const owner = readJson<{ pid: number }>(join(worker.reference.directory, "owner.json"));
      if (owner && isAlive(owner.pid)) throw new Error("This worker still has a live Pi process; reconnect before resuming it");
      mkdirSync(dirname(worker.manifest.socketPath), { recursive: true, mode: 0o700 });
      const rex = new Rex(worker.manifest.rex);
      try {
        worker.pane = await rex.create(worker.manifest, this.command(worker.manifest));
      } catch (error) {
        worker.pane = await rex.recover(worker.manifest).catch(() => undefined);
        if (!worker.pane) {
          worker.connection = "closed";
          worker.error = `Worker launch failed: ${error instanceof Error ? error.message : error}`;
          this.changed(worker);
          throw error;
        }
      }
      writeJson(join(worker.reference.directory, "pane.json"), worker.pane);
      try {
        await rex.present(worker.pane, true);
      } catch (error) {
        worker.error = `Worker launched, but minimization failed: ${error instanceof Error ? error.message : error}`;
      }
      this.connect(worker);
      // Startup can include credentials, trust dialogs, or MCP initialization.
      // Preserve the pane and return its identity even if the bridge is not ready.
      this.changed(worker);
    } finally {
      release();
    }
  }

  async resume(worker: Worker, prompt?: string): Promise<Worker> {
    return this.serial(async () => {
      if (worker.connection === "connecting" || worker.connection === "disconnected") await this.reconcile(worker);
      this.assertLive();
      if (worker.connection === "connected") {
        if (worker.state && active(worker.state.status)) throw new Error("Worker is busy; use steer_subagent");
        if (prompt) await this.steer(worker, prompt);
        return worker;
      }
      if (worker.connection !== "closed") throw new Error("Worker is reconnecting. Open its pane to inspect it before resuming.");
      if (!statSync(worker.manifest.cwd).isDirectory()) throw new Error(`Worker cwd is not a directory: ${worker.manifest.cwd}`);
      this.capacity();
      const owner = readJson<{ pid: number }>(join(worker.reference.directory, "owner.json"));
      if (owner && isAlive(owner.pid)) throw new Error("The worker's previous Pi process is still exiting. Wait before resuming it.");
      // Remove only this worker's exited terminal before reusing its stable label.
      if (worker.pane) {
        if (await new Rex(worker.manifest.rex).running(worker.pane.block)) {
          throw new Error("The worker's previous terminal process is still exiting. Wait before resuming it.");
        }
        await new Rex(worker.manifest.rex).call("block.close", { block_id: worker.pane.block }).catch(() => {});
      }
      worker.manifest = {
        ...worker.manifest, instance: randomUUID(),
        model: worker.state?.model ?? worker.manifest.model,
        thinking: worker.state?.thinking ?? worker.manifest.thinking,
        initialPrompt: prompt ? join(worker.reference.directory, "assignment.md") : undefined,
      };
      if (prompt) writePrivate(worker.manifest.initialPrompt!, prompt);
      writeJson(join(worker.reference.directory, "launch.json"), worker.manifest);
      worker.connection = "connecting";
      worker.state = undefined;
      worker.pane = undefined;
      await this.launch(worker);
      return worker;
    });
  }

  async steer(worker: Worker, message: string): Promise<void> {
    if (worker.connection !== "connected" || !worker.client) throw new Error("Worker is not connected. Open /agents to inspect or resume it.");
    await worker.client.call("steer", message);
  }

  async stop(worker: Worker): Promise<void> {
    if (!worker.client) throw new Error("Worker is not connected");
    await worker.client.call("abort");
  }

  async close(worker: Worker): Promise<void> {
    const rex = new Rex(worker.manifest.rex);
    if (worker.client) {
      await worker.client.call("shutdown").catch(() => {});
      for (let i = 0; worker.pane && i < 30 && await rex.running(worker.pane.block); i++) await delay(100);
    }
    if (worker.pane) {
      try {
        await rex.call("block.close", { block_id: worker.pane.block });
      } catch (error) {
        if (!/not_found|session_not_found/.test(String(error))) throw error;
      }
    }
    worker.client?.close();
    worker.client = undefined;
    if (worker.retry) clearTimeout(worker.retry);
    worker.retry = undefined;
    worker.connection = "closed";
    this.changed(worker);
  }

  async present(worker: Worker, minimized: boolean): Promise<void> {
    if (worker.connection === "closed" && !minimized && worker.state?.sessionFile) await this.resume(worker);
    if (!worker.pane) throw new Error("Worker pane is unavailable");
    await new Rex(worker.manifest.rex).present(worker.pane, minimized);
  }

  result(worker: Worker, revision = worker.state?.resultRevision): WorkerResult | undefined {
    return revision ? readJson<WorkerResult>(resultPath(worker.reference.directory, revision)) : undefined;
  }

  async wait(worker: Worker, signal?: AbortSignal): Promise<WorkerResult | undefined> {
    // A newly launched process can still be bootstrapping with the previous
    // instance's snapshot on disk. Wait until this instance identifies itself.
    while (!worker.state && worker.connection !== "closed") {
      this.assertLive(signal);
      await delay(100, undefined, { signal });
    }
    const revision = worker.state?.run;
    while (revision && (worker.state?.resultRevision ?? 0) < revision) {
      this.assertLive(signal);
      if (worker.connection === "closed") throw new Error(worker.error || "Worker closed before returning a result");
      await delay(100, undefined, { signal });
    }
    this.assertLive(signal);
    return this.result(worker, revision);
  }

  private assertLive(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error("The parent extension has shut down");
  }

  dispose(): void {
    this.disposed = true;
    for (const stop of this.stops) stop();
    for (const worker of this.workers.values()) {
      if (worker.retry) clearTimeout(worker.retry);
      worker.client?.close();
    }
    this.workers.clear();
  }
}
