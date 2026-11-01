export interface Completion {
  id: string;
  revision: number;
  content: string;
}

/** Batch completions at a tool-batch boundary or shortly after the parent idles. */
export class CompletionOutbox {
  private pending = new Map<string, Completion>();
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private busy: () => boolean,
    private send: (items: Completion[]) => void,
  ) {}

  add(item: Completion): void {
    const previous = this.pending.get(item.id);
    if (!previous || previous.revision <= item.revision) this.pending.set(item.id, item);
    if (!this.busy()) this.arm();
  }

  consume(id: string, revision: number): void {
    if ((this.pending.get(id)?.revision ?? Infinity) <= revision) this.pending.delete(id);
  }

  boundary(failed = false): void {
    if (!failed) this.flush();
  }

  settled(): void {
    if (this.pending.size) this.arm();
  }

  private arm(): void {
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      // Settlement handlers can run before Pi drops its busy flag. Retry once
      // the host is idle; never inject a timer message into a cleared queue.
      if (this.busy()) this.arm();
      else this.flush();
    }, 200);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const items = [...this.pending.values()];
    if (!items.length) return;
    this.send(items);
    for (const item of items) {
      if (this.pending.get(item.id) === item) this.pending.delete(item.id);
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
  }
}
