import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  acquireLock, active, isAlive, loadManifest, piInvocation,
  readJson, resultPath, stateRoot, writeJson, writePrivate,
  type AgentDefinition, type ForkContext, type Manifest, type Pane, type WorkerReference, type WorkerResult, type WorkerState,
} from "./state.ts";
import { BridgeClient } from "./transport.ts";
import { Rex } from "./rex.ts";
import type { ControllerOptions } from "./types/controller-options.ts";

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

  constructor(private options: ControllerOptions) {}

  async attach(references: WorkerReference[]): Promise<void> {
    await this.serial(async () => {
      const locations = new Set<string>();
      for (const reference of references) {
        this.assertLive();
        try {
          const worker = await this.adopt(reference);
          this.assertLive();
          if (!worker.client) this.connect(worker);
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
          if (!this.options.isOwner()) return;
          const worker = this.workers.get(reference.id);
          if (worker) {
            worker.connection = "disconnected";
            worker.error = `Could not restore worker: ${error instanceof Error ? error.message : error}`;
            console.error(worker.error, error);
            this.changed(worker);
          } else {
            // A missing/corrupt manifest should not prevent restoring other workers.
            this.options.onChange({
              reference, manifest: { id: reference.id, name: reference.id } as Manifest,
              connection: "closed", error: String(error),
            });
          }
        }
      }
    });
  }

  private async lock(directory: string): Promise<() => void> {
    const path = join(directory, "launch-lock.json");
    const deadline = Date.now() + 30_000;
    while (true) {
      this.assertLive();
      const owner = readJson<{ pid: number }>(path);
      if (!owner || !isAlive(owner.pid)) return acquireLock(path);
      if (Date.now() >= deadline) throw new Error("Worker is still being relocated by another parent. Reload to retry.");
      await delay(100);
    }
  }

  private async adopt(reference: WorkerReference): Promise<Worker> {
    const release = await this.lock(reference.directory);
    try {
      const worker = this.add(reference);
      const location = this.options.location;
      if (!location || (!worker.manifest.reopen
        && worker.manifest.rex.session === location.session
        && worker.manifest.rex.server === location.server
        && worker.manifest.rex.parentBlock === location.parentBlock)) return worker;
      const target = new Rex(location);
      await target.check();
      this.assertLive();
      const source = new Rex(worker.manifest.rex);
      worker.pane = await source.recover(worker.manifest);
      const sameSession = worker.manifest.rex.session === location.session
        && worker.manifest.rex.server === location.server;
      if (sameSession && !worker.manifest.reopen) {
        if (worker.pane) await target.relocate(worker.pane);
        this.assertLive();
        worker.manifest.rex = location;
        writeJson(join(reference.directory, "launch.json"), worker.manifest);
        if (worker.pane) writeJson(join(reference.directory, "pane.json"), worker.pane);
        else rmSync(join(reference.directory, "pane.json"), { force: true });
        return worker;
      }

      const owner = readJson<{ pid: number }>(join(reference.directory, "owner.json"));
      const running = worker.manifest.reopen || (owner && isAlive(owner.pid))
        || (worker.pane && await source.running(worker.pane.block));
      this.assertLive();
      // Keep the reopen intent durable if another parent takes over during shutdown.
      if (running) {
        worker.manifest.reopen = true;
        writeJson(join(reference.directory, "launch.json"), worker.manifest);
      }
      if (worker.pane) {
        await source.close(worker.pane);
      }
      const closingOwner = readJson<{ pid: number }>(join(reference.directory, "owner.json")) ?? owner;
      if (closingOwner && isAlive(closingOwner.pid)) {
        const deadline = Date.now() + 15_000;
        while (isAlive(closingOwner.pid)) {
          this.assertLive();
          if (Date.now() >= deadline) throw new Error("Worker has not finished shutting down. Reload to retry its move.");
          await delay(100);
        }
      }
      this.assertLive();
      worker.state = readJson<WorkerState>(join(reference.directory, "state.json")) ?? worker.state;
      worker.manifest = {
        ...worker.manifest, rex: location,
        instance: running ? randomUUID() : worker.manifest.instance,
        model: worker.state?.model ?? worker.manifest.model,
        thinking: worker.state?.thinking ?? worker.manifest.thinking,
        initialPrompt: undefined,
      };
      writeJson(join(reference.directory, "launch.json"), worker.manifest);
      rmSync(join(reference.directory, "pane.json"), { force: true });
      worker.pane = undefined;
      worker.connection = "closed";
      if (running) {
        worker.state = undefined;
        await this.launchUnlocked(worker);
      }
      return worker;
    } finally {
      release();
    }
  }

  private add(reference: WorkerReference): Worker {
    const manifest = loadManifest(reference.directory);
    if (manifest.id !== reference.id || manifest.parentSessionId !== this.options.parentId) {
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
    if (!this.disposed && this.options.isOwner()) this.options.onChange(worker);
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
    if (this.disposed || !this.options.isOwner() || (worker.manifest.stopped && worker.connection === "closed")) return;
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
      this.assertLive();
      return operation();
    });
    this.launchQueue = next.catch(() => {});
    return next;
  }

  async spawn(options: LaunchOptions): Promise<Worker> {
    return this.serial(async () => {
      if (!this.options.location) throw new Error("Launch Pi inside Rex to create worker panes");
      const cwd = resolve(options.cwd);
      if (!statSync(cwd).isDirectory()) throw new Error(`Worker cwd is not a directory: ${cwd}`);
      if (options.name && [...this.workers.values()].some((worker) => worker.manifest.name === options.name)) {
        throw new Error(`Worker name "${options.name}" is already in use`);
      }
      await new Rex(this.options.location).check();
      this.assertLive();
      const id = randomUUID();
      const directory = join(stateRoot(), encodeURIComponent(this.options.parentId), id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const runtime = mkdtempSync("/tmp/pi-rex-");
      const manifest: Manifest = {
        version: 1, id, instance: randomUUID(),
        name: options.name || `${options.agent.name}-${id.slice(0, 6)}`,
        description: options.description,
        parentSessionId: this.options.parentId, sessionId: randomUUID(), agentDir: options.agentDir, cwd, directory,
        socketPath: join(runtime, "worker.sock"), rex: this.options.location,
        agent: options.agent, model: options.model, thinking: options.thinking,
        context: options.fork ? "fork" : "fresh",
        initialPrompt: join(directory, "assignment.md"),
      };
      // Persist the session before launch so Pi can resolve --session-id.
      // Forked workers also receive the captured active branch.
      const session = SessionManager.create(cwd, join(directory, "sessions"), {
        id: manifest.sessionId, parentSession: options.fork?.parentSession,
      });
      writePrivate(session.getSessionFile()!, [session.getHeader(), ...(options.fork?.entries ?? [])]
        .map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      writePrivate(manifest.initialPrompt!, options.prompt);
      writePrivate(join(directory, "agent-prompt.md"), manifest.agent.prompt);
      writeJson(join(directory, "launch.json"), manifest);
      const reference = { id, directory };
      this.options.onWorker(reference);
      const worker = this.add(reference);
      await this.launch(worker);
      return worker;
    });
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
    return [
      "/usr/bin/env",
      `PI_REX_WORKER=${join(manifest.directory, "launch.json")}`,
      `PI_CODING_AGENT_DIR=${manifest.agentDir}`,
      ...(process.env.PI_OFFLINE ? [`PI_OFFLINE=${process.env.PI_OFFLINE}`] : []),
      ...piInvocation(args),
    ];
  }

  private async launch(worker: Worker): Promise<void> {
    const release = await this.lock(worker.reference.directory);
    try {
      await this.launchUnlocked(worker);
    } finally {
      release();
    }
  }

  private async launchUnlocked(worker: Worker): Promise<void> {
    this.assertLive();
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
    if (worker.manifest.reopen) {
      worker.manifest.reopen = undefined;
      writeJson(join(worker.reference.directory, "launch.json"), worker.manifest);
    }
    this.assertLive();
    try {
      await rex.present(worker.pane, true);
    } catch (error) {
      worker.error = `Worker launched, but minimization failed: ${error instanceof Error ? error.message : error}`;
    }
    this.connect(worker);
    // Startup can include credentials, trust dialogs, or MCP initialization.
    // Preserve the pane and return its identity even if the bridge is not ready.
    this.changed(worker);
  }

  async resume(worker: Worker, prompt?: string): Promise<Worker> {
    return this.serial(async () => {
      const release = await this.lock(worker.reference.directory);
      try {
        return await this.resumeUnlocked(worker, prompt);
      } finally {
        release();
      }
    });
  }

  private async resumeUnlocked(worker: Worker, prompt?: string): Promise<Worker> {
    if (worker.connection === "connecting" || worker.connection === "disconnected") await this.reconcile(worker);
    this.assertLive();
    if (worker.connection === "connected") {
      if (worker.state && active(worker.state.status)) throw new Error("Worker is busy; use steer_subagent");
      if (prompt) await this.steer(worker, prompt);
      return worker;
    }
    if (worker.connection !== "closed") throw new Error("Worker is reconnecting. Open its pane to inspect it before resuming.");
    if (!statSync(worker.manifest.cwd).isDirectory()) throw new Error(`Worker cwd is not a directory: ${worker.manifest.cwd}`);
    const owner = readJson<{ pid: number }>(join(worker.reference.directory, "owner.json"));
    if (owner && isAlive(owner.pid)) throw new Error("The worker's previous Pi process is still exiting. Wait before resuming it.");
    // Remove only this worker's exited terminal before reusing its stable label.
    if (worker.pane) {
      if (await new Rex(worker.manifest.rex).running(worker.pane.block)) {
        throw new Error("The worker's previous terminal process is still exiting. Wait before resuming it.");
      }
      this.assertLive();
      await new Rex(worker.manifest.rex).close(worker.pane);
    }
    this.assertLive();
    worker.manifest = {
      ...worker.manifest, instance: randomUUID(),
      stopped: undefined,
      model: worker.state?.model ?? worker.manifest.model,
      thinking: worker.state?.thinking ?? worker.manifest.thinking,
      initialPrompt: prompt ? join(worker.reference.directory, "assignment.md") : undefined,
    };
    if (prompt) writePrivate(worker.manifest.initialPrompt!, prompt);
    writeJson(join(worker.reference.directory, "launch.json"), worker.manifest);
    worker.connection = "connecting";
    worker.state = undefined;
    worker.pane = undefined;
    await this.launchUnlocked(worker);
    return worker;
  }

  async steer(worker: Worker, message: string): Promise<void> {
    this.assertLive();
    if (worker.connection !== "connected" || !worker.client) throw new Error("Worker is not connected. Inspect its pane in Rex or use spawn_subagent with resume.");
    await worker.client.call("steer", message);
  }

  async stop(worker: Worker): Promise<void> {
    return this.serial(async () => {
      if (worker.connection === "connecting" || worker.connection === "disconnected") await this.reconcile(worker);
      // Allow an already launched Pi to finish starting its bridge.
      const deadline = Date.now() + 5_000;
      while (worker.connection !== "connected" || !worker.client) {
        this.assertLive();
        if (worker.connection === "closed") throw new Error("Worker's Pi process has exited. Use spawn_subagent with resume to reopen its conversation.");
        if (Date.now() >= deadline) throw new Error("Worker is not connected. Open its Pi pane and press Escape to interrupt it.");
        await delay(100);
      }
      this.assertLive();
      await worker.client.call("stop");
    });
  }

  result(worker: Worker, revision = worker.state?.parentResultRevision ?? worker.state?.resultRevision): WorkerResult | undefined {
    this.assertLive();
    const result = revision ? readJson<WorkerResult>(resultPath(worker.reference.directory, revision)) : undefined;
    return result?.reportToParent === false ? undefined : result;
  }

  async wait(worker: Worker, signal?: AbortSignal): Promise<WorkerResult | undefined> {
    // A newly launched process can still be bootstrapping with the previous
    // instance's snapshot on disk. Wait until this instance identifies itself.
    while (!worker.state && worker.connection !== "closed") {
      this.assertLive(signal);
      await delay(100, undefined, { signal });
    }
    const revision = worker.state?.reportToParent === false ? worker.state.parentResultRevision : worker.state?.run;
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
    if (!this.options.isOwner()) throw new Error("Workers belong to the most recently opened copy of this Pi session.");
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
