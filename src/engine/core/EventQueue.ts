/** Min-heap of scheduled events ordered by (time, seq). `seq` is a monotonically increasing
 * insertion counter, so events at the same sim time run in the order they were scheduled.
 * That tie-break is what makes the simulation deterministic. */

export interface ScheduledEvent {
  time: number;
  seq: number;
  /** Short description, shown when single-stepping. */
  label: string;
  nodeId?: string;
  run: () => void;
  cancelled?: boolean;
}

export class EventQueue {
  private heap: ScheduledEvent[] = [];
  private nextSeq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(time: number, label: string, run: () => void, nodeId?: string): ScheduledEvent {
    const ev: ScheduledEvent = { time, seq: this.nextSeq++, label, run };
    if (nodeId !== undefined) ev.nodeId = nodeId;
    this.heap.push(ev);
    this.up(this.heap.length - 1);
    return ev;
  }

  /** Earliest non-cancelled event, without removing it. */
  peek(): ScheduledEvent | undefined {
    this.dropCancelled();
    return this.heap[0];
  }

  pop(): ScheduledEvent | undefined {
    this.dropCancelled();
    return this.popRaw();
  }

  clear(): void {
    this.heap = [];
  }

  private dropCancelled(): void {
    while (this.heap.length && this.heap[0]!.cancelled) this.popRaw();
  }

  private popRaw(): ScheduledEvent | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      this.down(0);
    }
    return top;
  }

  private less(a: ScheduledEvent, b: ScheduledEvent): boolean {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }

  private up(i: number): void {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  private down(i: number): void {
    const h = this.heap;
    const n = h.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.less(h[l]!, h[m]!)) m = l;
      if (r < n && this.less(h[r]!, h[m]!)) m = r;
      if (m === i) break;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
  }
}
