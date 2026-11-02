import { execFile, spawn, type ChildProcess } from "node:child_process";
import { delimiter } from "node:path";
import { promisify } from "node:util";
import type { Manifest, Pane } from "./state.ts";

const exec = promisify(execFile);
const BOUNDS = [0.08, 0.06, 0.84, 0.86];

interface Block {
  block_id: string;
  label?: string;
  window_id?: string;
  host_id?: string;
}

interface Layer {
  layer_id: string;
  kind: string;
  state?: string;
  blocks: Block[];
}

interface View {
  windows: { window_id: string; layers: Layer[] }[];
}

export class Rex {
  private checked?: Promise<void>;

  constructor(readonly location: Manifest["rex"]) {}

  private options(): string[] {
    return [
      "--autostart=false", "--timeout", "10s",
      ...(this.location.server ? ["--server", this.location.server] : []),
    ];
  }

  async call<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    const { stdout } = await exec("rex", [
      ...this.options(), "api", "call", method,
      JSON.stringify({ ...args, ...(method.startsWith("session.") || method.startsWith("block.") || method.startsWith("com.")
        ? { session_id: this.location.session } : {}) }),
    ], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout) as T;
  }

  async check(): Promise<void> {
    this.checked ??= (async () => {
      const { stdout } = await exec("rex", [...this.options(), "api", "list", "--json"], { maxBuffer: 8 * 1024 * 1024 });
      const methods = new Set((JSON.parse(stdout) as { methods: { name: string }[] }).methods.map((m) => m.name));
      for (const method of ["session.new_layer", "session.set_layer_state", "session.float_block", "session.view"]) {
        if (!methods.has(method)) throw new Error(`The connected Rex server needs ${method}`);
      }
      const [parent, identity] = await Promise.all([
        this.call<{ block: Block }>("session.describe_block", { block_id: this.location.parentBlock }),
        this.call<{ host_id: string }>("server.status"),
      ]);
      if (!parent.block.window_id) throw new Error("The parent Pi pane is not attached to a Rex tab");
      if (parent.block.host_id && parent.block.host_id !== identity.host_id) {
        throw new Error("Rex workers require the parent and terminal server to share the local filesystem");
      }
    })();
    return this.checked;
  }

  async create(manifest: Manifest, command: string[]): Promise<Pane> {
    await this.check();
    const parent = await this.call<{ block: Block }>("session.describe_block", { block_id: this.location.parentBlock });
    if (!parent.block.window_id) throw new Error("The parent Rex tab no longer exists");
    const created = await this.call<{ layer_id: string; block_ids: string[] }>("session.new_layer", {
      window_id: parent.block.window_id, bounds: BOUNDS, focus: false,
      layout: { block: {
        flavor: "com.superlogical.terminal.shell",
        label: this.label(manifest),
        options: {
          command, cwd: manifest.cwd,
          path_prepend: process.env.PATH?.split(delimiter),
          size: { columns: 120, rows: 36 },
          exit: { on_completion: false },
        },
      } },
    });
    return { instance: manifest.instance, block: created.block_ids[0], layer: created.layer_id };
  }

  label(manifest: Manifest): string {
    return `${manifest.name.slice(0, 60)} [${manifest.id}]`;
  }

  async recover(manifest: Manifest): Promise<Pane | undefined> {
    const { blocks } = await this.call<{ blocks: Block[] }>("session.list_blocks");
    const matches = blocks.filter((block) => block.label === this.label(manifest));
    if (matches.length > 1) throw new Error(`Multiple Rex panes match worker ${manifest.id}; inspect them in Rex before retrying`);
    return matches[0] ? { instance: manifest.instance, block: matches[0].block_id } : undefined;
  }

  async present(pane: Pane, minimized: boolean): Promise<void> {
    const view = await this.call<View>("session.view");
    let layer = view.windows.flatMap((window) => window.layers)
      .find((candidate) => candidate.blocks?.some((block) => block.block_id === pane.block));
    if (!layer) throw new Error("The worker pane is no longer attached to a Rex tab");
    if (layer.kind === "tiled") {
      const floated = await this.call<{ layer_id: string }>("session.float_block", { block_id: pane.block, bounds: BOUNDS });
      layer = { ...layer, layer_id: floated.layer_id };
    }
    await this.call("session.set_layer_state", {
      layer_id: layer.layer_id, state: minimized ? "minimized" : "normal",
      ...(minimized ? {} : { focus: true }),
    });
    pane.layer = layer.layer_id;
  }

  async running(block: string): Promise<boolean> {
    try {
      const process = await this.call<{ last_exit: unknown }>("com.superlogical.terminal.process", { block_id: block, args: {} });
      return process.last_exit === null;
    } catch (error) {
      if (/not_found|session_not_found/.test(String(error))) return false;
      throw error;
    }
  }

  watch(onChange: () => void): () => void {
    const process: ChildProcess = spawn("rex", [...this.options(), "events", "-s", this.location.session, "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    process.stdout?.on("data", onChange);
    process.on("error", () => {});
    return () => { process.kill(); };
  }
}
