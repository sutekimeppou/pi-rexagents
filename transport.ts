import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";

const MAX_FRAME = 256 * 1024;

export interface Request {
  id: string;
  method: "subscribe" | "steer" | "abort" | "shutdown";
  message?: string;
}

type Frame =
  | { id: string; value?: unknown; error?: string }
  | { event: "state"; state: unknown };

function write(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function frames(socket: Socket, receive: (value: unknown) => void): void {
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (data: string) => {
    buffer += data;
    if (Buffer.byteLength(buffer) > MAX_FRAME) {
      socket.destroy(new Error("Worker protocol frame is too large"));
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        receive(JSON.parse(line));
      } catch {
        socket.destroy(new Error("Invalid worker protocol frame"));
        return;
      }
    }
  });
}

function request(value: unknown): Request {
  if (!value || typeof value !== "object") throw new Error("Invalid request");
  const input = value as Request;
  if (typeof input.id !== "string" || !["subscribe", "steer", "abort", "shutdown"].includes(input.method)) {
    throw new Error("Invalid worker request");
  }
  if (input.method === "steer" && (typeof input.message !== "string" || !input.message.trim())) {
    throw new Error("Steering requires a nonempty message");
  }
  return input;
}

export class BridgeServer {
  private server: Server;
  private clients = new Set<Socket>();
  private subscribers = new Set<Socket>();

  constructor(
    private path: string,
    private snapshot: () => unknown,
    private handle: (input: Request) => unknown,
  ) {
    this.server = createServer((socket) => {
      this.clients.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => {
        this.clients.delete(socket);
        this.subscribers.delete(socket);
      });
      frames(socket, (value) => {
        let id = "";
        try {
          const input = request(value);
          id = input.id;
          if (input.method === "subscribe") {
            this.subscribers.add(socket);
            write(socket, { id, value: this.snapshot() });
          } else {
            write(socket, { id, value: this.handle(input) });
          }
        } catch (error) {
          write(socket, { id, error: String(error instanceof Error ? error.message : error) });
        }
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, () => {
        this.server.removeListener("error", reject);
        chmodSync(this.path, 0o600);
        resolve();
      });
    });
    this.server.on("error", () => {});
  }

  publish(): void {
    for (const socket of this.subscribers) {
      // A stopped reader must not accumulate an unbounded history of snapshots.
      if (socket.writableLength > MAX_FRAME) socket.destroy();
      else write(socket, { event: "state", state: this.snapshot() });
    }
  }

  async close(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    rmSync(this.path, { force: true });
  }
}

export class BridgeClient {
  private socket: Socket;
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private disposed = false;

  constructor(
    path: string,
    private onState: (state: unknown) => void,
    private onClose: () => void,
  ) {
    this.socket = createConnection(path);
    this.socket.on("error", () => {});
    this.socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Worker disconnected; request delivery may be ambiguous"));
      }
      this.pending.clear();
      if (!this.disposed) this.onClose();
    });
    frames(this.socket, (value) => {
      const frame = value as Frame;
      if ("event" in frame) {
        if (frame.event === "state") this.onState(frame.state);
        return;
      }
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error) pending.reject(new Error(frame.error));
      else pending.resolve(frame.value);
    });
  }

  call(method: Request["method"], message?: string): Promise<unknown> {
    if (this.disposed || this.socket.destroyed) return Promise.reject(new Error("Worker is disconnected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Worker request timed out; delivery may be ambiguous"));
      }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
      const frame = { id, method, message };
      if (Buffer.byteLength(JSON.stringify(frame)) > MAX_FRAME - 1) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Worker message is too large"));
        return;
      }
      write(this.socket, frame);
    });
  }

  close(): void {
    this.disposed = true;
    this.socket.destroy();
  }
}
