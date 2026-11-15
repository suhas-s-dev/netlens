import { describe, expect, it } from 'vitest';
import { EventQueue } from '../core/EventQueue';
import { Rng } from '../core/Rng';

describe('EventQueue', () => {
  it('orders by time, then insertion order', () => {
    const q = new EventQueue();
    const out: string[] = [];
    q.push(30, 'c', () => out.push('c'));
    q.push(10, 'a1', () => out.push('a1'));
    q.push(20, 'b', () => out.push('b'));
    q.push(10, 'a2', () => out.push('a2'));
    q.push(10, 'a3', () => out.push('a3'));
    while (q.size) q.pop()!.run();
    expect(out).toEqual(['a1', 'a2', 'a3', 'b', 'c']);
  });

  it('skips cancelled events', () => {
    const q = new EventQueue();
    const e = q.push(1, 'x', () => {});
    q.push(2, 'y', () => {});
    e.cancelled = true;
    expect(q.peek()!.label).toBe('y');
  });

  it('stays ordered under many random inserts', () => {
    const q = new EventQueue();
    const rng = new Rng(1);
    for (let i = 0; i < 2000; i++) q.push(rng.int(0, 100), String(i), () => {});
    let last = { time: -1, seq: -1 };
    while (q.size) {
      const e = q.pop()!;
      expect(e.time > last.time || (e.time === last.time && e.seq > last.seq)).toBe(true);
      last = e;
    }
  });
});

describe('Rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const c = new Rng(43);
    const sa = Array.from({ length: 5 }, () => a.nextU32());
    expect(Array.from({ length: 5 }, () => b.nextU32())).toEqual(sa);
    expect(Array.from({ length: 5 }, () => c.nextU32())).not.toEqual(sa);
  });
});
