import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const ENTRY = "rex-subagents";
export const PREVIEW_LENGTH = 12_000;

export interface AgentDefinition {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  extensions: boolean;
  skills: boolean;
}

export interface ForkContext {
  entries: SessionEntry[];
  parentSession?: string;
}

export interface Manifest {
  version: 1;
  id: string;
  instance: string;
  name: string;
  description: string;
  parentSessionId: string;
  sessionId: string;
  agentDir: string;
  cwd: string;
  directory: string;
  socketPath: string;
  rex: { server?: string; session: string; parentBlock: string };
  agent: AgentDefinition;
  model: string;
  thinking: string;
  context?: "fresh" | "fork";
  initialPrompt?: string;
  stopped?: boolean;
  reopen?: boolean;
}

export interface Pane {
  instance: string;
  block: string;
  layer?: string;
}

export type Status = "idle" | "starting" | "running" | "blocked" | "completed" | "aborted" | "error" | "closed";

export interface WorkerState {
  version: 1;
  id: string;
  instance: string;
  pid: number;
  block?: string;
  sessionFile?: string;
  model?: string;
  thinking?: string;
  run: number;
  resultRevision: number;
  parentResultRevision?: number;
  reportToParent?: boolean;
  suppressedRevision?: number;
  status: Status;
  runStartLeaf: string | null;
  updatedAt: string;
  error?: string;
}

export interface WorkerResult {
  id: string;
  revision: number;
  reportToParent?: boolean;
  outcome: "completed" | "aborted" | "error";
  text: string;
  error?: string;
  sessionFile?: string;
  leafId: string | null;
  completedAt: string;
}

export interface WorkerReference {
  id: string;
  directory: string;
}

export type ParentEntry =
  | { action: "worker"; worker: WorkerReference }
  | { action: "consumed"; id: string; revision: number };

export function stateRoot(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pi", "rex-subagents");
}

export function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writePrivate(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
}

export function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** Conservative PID ownership: an ambiguous living owner is never evicted. */
export function acquireLock(path: string): () => void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
      } finally {
        closeSync(fd);
      }
      return () => {
        if (readJson<{ token: string }>(path)?.token === token) rmSync(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = readJson<{ pid: number }>(path);
      if (!owner || isAlive(owner.pid)) throw new Error(`Worker is already owned by a live process: ${path}`);
      rmSync(path);
    }
  }
  throw new Error(`Could not acquire worker lock: ${path}`);
}

export function active(status: Status): boolean {
  return status === "starting" || status === "running" || status === "blocked";
}

export function resultPath(directory: string, revision: number): string {
  return join(directory, "results", `${revision}.json`);
}

export function loadManifest(directory: string): Manifest {
  const manifest = readJson<Manifest>(join(directory, "launch.json"));
  if (!manifest || manifest.version !== 1 || manifest.directory !== directory) {
    throw new Error(`Invalid worker manifest: ${directory}`);
  }
  return manifest;
}

export function piInvocation(args: string[]): string[] {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && existsSync(script)) {
    return [process.execPath, script, ...args];
  }
  return [process.execPath, ...args];
}

export function reconstruct(entries: readonly { type: string; customType?: string; data?: unknown }[]): {
  workers: WorkerReference[];
  consumed: Map<string, number>;
} {
  const workers = new Map<string, WorkerReference>();
  const consumed = new Map<string, number>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY || !entry.data) continue;
    const data = entry.data as ParentEntry;
    if (data.action === "worker") workers.set(data.worker.id, data.worker);
    if (data.action === "consumed") consumed.set(data.id, Math.max(consumed.get(data.id) ?? 0, data.revision));
  }
  return { workers: [...workers.values()], consumed };
}
