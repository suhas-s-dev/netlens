import { describe, expect, it } from 'vitest';
import { MS, SEC } from '../core/time';
import type { HostState } from '../devices/state';
import type { TableEvent, TxEvent } from '../trace/events';
import { appLines, lanTopology, make, texts } from './helpers';

describe('ARP', () => {
  it('resolves before the first ping, then uses the cache', () => {
    const { engine, events } = make(lanTopology(3));
    engine.ping('h1', '10.0.0.2', { count: 2 });
    engine.runUntil(5 * SEC);

    const t = texts(events);
    expect(t).toContain('H1 has no ARP entry for 10.0.0.2; queuing packet and resolving');
    expect(t).toContain('H1 broadcasting ARP request: who has 10.0.0.2? tell 10.0.0.1 (attempt 1/3)');
    expect(t).toContain('H2 learned 10.0.0.1 is at 02:00:00:00:01:01 (from ARP request)');
    expect(t).toContain('H2 replying to ARP: 10.0.0.2 is at 02:00:00:00:02:01');
    expect(t).toContain('H1 learned 10.0.0.2 is at 02:00:00:00:02:01 (from ARP reply)');
    expect(t).toContain('H1 resolved 10.0.0.2 → 02:00:00:00:02:01; sending 1 queued packet(s)');
    // H3 sees the broadcast request but is not the target, and has no entry to merge.
    expect(t).toContain('H3 ignored ARP request for 10.0.0.2 (not its address on eth0)');
    expect(engine.getState('h3')!.kind === 'host' && (engine.getState('h3') as HostState).arp).toEqual([]);

    // Exactly one ARP request was broadcast by H1; the second ping hit the cache.
    const arpTx = events.filter((e): e is TxEvent => e.type === 'tx' && e.node === 'h1' && e.cls === 'arp');
    expect(arpTx).toHaveLength(1);
    expect(events.some((e) => e.type === 'table' && e.node === 'h1' && e.op === 'hit' && e.key === '10.0.0.2')).toBe(true);

    expect(appLines(events).filter((l) => l.includes('bytes from'))).toHaveLength(2);
    // H2 replied using the entry it learned from the request: it never sent its own ARP request.
    expect(events.some((e) => e.type === 'tx' && e.node === 'h2' && e.cls === 'arp' && e.text.includes('Who has'))).toBe(false);
  });

  it('queues packets while resolution is pending and flushes them in order', () => {
    const { engine, events } = make(lanTopology(2));
    // Three echoes 10 µs apart: all are sent before the ARP reply can arrive (~4 ms).
    engine.ping('h1', '10.0.0.2', { count: 3, intervalNs: 10_000 });
    engine.runUntil(1 * MS);
    const st = engine.getState('h1') as HostState;
    expect(st.arp).toEqual([expect.objectContaining({ ip: '10.0.0.2', state: 'incomplete', queued: 3, mac: null })]);
    expect(texts(events)).toContain('H1 queued packet for 10.0.0.2 while ARP is pending (3 waiting)');

    engine.runUntil(3 * SEC);
    expect(texts(events)).toContain('H1 resolved 10.0.0.2 → 02:00:00:00:02:01; sending 3 queued packet(s)');
    const echoes = events.filter((e): e is TxEvent => e.type === 'tx' && e.node === 'h1' && e.cls === 'icmp-request');
    expect(echoes.map((e) => e.frame.eth.payload.kind === 'ipv4' && e.frame.eth.payload.payload.kind === 'icmp' && 'sequence' in e.frame.eth.payload.payload ? e.frame.eth.payload.payload.sequence : -1)).toEqual([1, 2, 3]);
    expect(appLines(events).filter((l) => l.includes('bytes from'))).toHaveLength(3);
  });

  it('drops the oldest queued packet when the per-destination queue overflows', () => {
    const { engine, events } = make(lanTopology(2));
    engine.ping('h1', '10.0.0.2', { count: 5, intervalNs: 10_000 });
    engine.runUntil(3 * SEC);
    expect(events.filter((e) => e.type === 'drop' && e.reason === 'queue-full')).toHaveLength(2);
    // Seq 1 and 2 were dropped (oldest first), so they time out; 3-5 are answered.
    const lines = appLines(events);
    expect(lines).toContain('H1 Request timeout for icmp_seq 1');
    expect(lines).toContain('H1 Request timeout for icmp_seq 2');
    expect(lines.filter((l) => l.includes('bytes from'))).toHaveLength(3);
  });

  it('retries 3 times at 1 s intervals, then reports Destination Host Unreachable', () => {
    const { engine, events } = make(lanTopology(2));
    engine.ping('h1', '10.0.0.99', { count: 1, timeoutNs: 10 * SEC });
    engine.runUntil(5 * SEC);
    const reqs = events.filter((e): e is TxEvent => e.type === 'tx' && e.node === 'h1' && e.cls === 'arp');
    expect(reqs.map((e) => e.time)).toEqual([0, 1 * SEC, 2 * SEC]);
    expect(texts(events)).toContain('H1 ARP for 10.0.0.99 failed after 3 attempts');
    expect(appLines(events)).toContain('H1 From 10.0.0.1 icmp_seq=1 Destination Host Unreachable (no ARP reply from 10.0.0.99)');
    expect((engine.getState('h1') as HostState).arp).toEqual([]);
  });

  it('ages entries out after the cache timeout', () => {
    const { engine, events } = make(lanTopology(2));
    engine.ping('h1', '10.0.0.2', { count: 1 });
    engine.runUntil(59 * SEC);
    expect((engine.getState('h1') as HostState).arp).toHaveLength(1);
    engine.runUntil(61 * SEC);
    expect((engine.getState('h1') as HostState).arp).toHaveLength(0);
    const removed = events.filter((e): e is TableEvent => e.type === 'table' && e.op === 'remove' && e.node === 'h1');
    expect(removed[0]!.text).toBe('H1 ARP entry 10.0.0.2 → 02:00:00:00:02:01 aged out after 60.000 s');
  });

  it('merges (refreshes) an existing entry from a request not addressed to it (RFC 826)', () => {
    const { engine, events } = make(lanTopology(3));
    engine.ping('h1', '10.0.0.3', { count: 1 }); // h3 learns h1
    engine.runUntil(1 * SEC);
    engine.ping('h1', '10.0.0.2', { count: 1 }); // broadcast request reaches h3 too
    engine.runUntil(2 * SEC);
    expect(texts(events)).toContain('H3 refreshed ARP entry 10.0.0.1 → 02:00:00:00:01:01 (from ARP request)');
  });
});
