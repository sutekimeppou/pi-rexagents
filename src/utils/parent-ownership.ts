import { randomUUID } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { readJson, stateRoot, writeJson } from "../state.ts";
import type { ParentOwnershipOptions } from "../types/parent-ownership-options.ts";

export class ParentOwnership {
  private token = randomUUID();
  private path: string;
  private active = true;
  private onLost: () => void;
  private check = () => {
    try {
      this.isCurrent();
    } catch (error) {
      console.error("Could not check Rex worker ownership", error);
      this.relinquish();
    }
  };

  constructor(options: ParentOwnershipOptions) {
    this.path = join(stateRoot(), encodeURIComponent(options.parentId), "parent.json");
    this.onLost = options.onLost;
    writeJson(this.path, { token: this.token, pid: process.pid });
    watchFile(this.path, { interval: 100, persistent: false }, this.check);
  }

  isCurrent(): boolean {
    if (!this.active) return false;
    if (readJson<{ token: string }>(this.path)?.token === this.token) return true;
    this.relinquish();
    return false;
  }

  private relinquish(): void {
    if (!this.active) return;
    this.dispose();
    this.onLost();
  }

  dispose(): void {
    this.active = false;
    unwatchFile(this.path, this.check);
  }
}
