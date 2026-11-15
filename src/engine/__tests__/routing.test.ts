import { describe, expect, it } from 'vitest';
import { SEC } from '../core/time';
import { buildRoutingTable, cidr, longestPrefixMatch } from '../devices/routing';
import { checksumValid } from '../protocols/checksum';
import { encodeEthernet } from '../protocols/ethernet';
import type { DropEvent, TxEvent } from '../trace/events';
import { appLines, chainTopology, host, link, make, router, texts, topo } from './helpers';

describe('longest-prefix match', () => {
  const routes = buildRoutingTable(
    [
      { id: 'eth0', addr: '10.0.2.1', prefix: 24 },
      { id: 'eth1', addr: '192.168.0.1', prefix: 30 },
      { id: 'eth2', addr: '172.16.0.1', prefix: 30 },
    ],
    [
      { network: '0.0.0.0', prefix: 0, nextHop: '192.168.0.2' },
      { network: '10.0.0.0', prefix: 8, nextHop: '192.168.0.2' },
      { network: '10.0.2.128', prefix: 25, nextHop: '172.16.0.2' },
      { network: '10.0.2.0', prefix: 24, nextHop: '172.16.0.2' }, // same length as connected
      { network: '8.8.8.0', prefix: 24, nextHop: '1.2.3.4' }, // next hop not on a connected subnet
    ],
  );

  it.each([
    ['10.0.2.15', '10.0.2.0/24', 'connected'], // /24 connected beats /24 static (admin distance) and /8
    ['10.0.2.200', '10.0.2.128/25', 'static'], // /25 beats /24
    ['10.9.9.9', '10.0.0.0/8', 'static'],
    ['8.8.8.8', '0.0.0.0/0', 'static'], // the /24 static is inactive
    ['192.168.0.2', '192.168.0.0/30', 'connected'],
  ])('%s → %s (%s)', (dst, expected, type) => {
    const { best } = longestPrefixMatch(routes, dst);
    expect(cidr(best!)).toBe(expected);
    expect(best!.type).toBe(type);
  });

  it('lists all matches best-first and marks unresolvable statics inactive', () => {
    expect(longestPrefixMatch(routes, '10.0.2.200').matches.map(cidr)).toEqual(['10.0.2.128/25', '10.0.2.0/24', '10.0.2.0/24', '10.0.0.0/8', '0.0.0.0/0']);
    expect(routes.find((r) => r.network === '8.8.8.0')!.active).toBe(false);
    expect(longestPrefixMatch(routes.filter((r) => r.prefix !== 0), '8.8.8.8').best).toBeUndefined();
  });
});

describe('router forwarding', () => {
  it('pings across three routers; TTL is decremented and checksums stay valid', () => {
    const { engine, events } = make(chainTopology());
    engine.ping('h1', '10.0.3.10', { count: 2 });
    engine.runUntil(5 * SEC);
    const lines = appLines(events);
    expect(lines.filter((l) => l.includes('bytes from 10.0.3.10'))).toHaveLength(2);
    expect(lines.some((l) => l.includes('ttl=61'))).toBe(true); // 64 - 3 routers
    expect(texts(events)).toContain('R1 LPM: 10.0.3.10 matched 0.0.0.0/0 via eth1 (static, next hop 10.0.12.2)');
    expect(texts(events)).toContain('R3 LPM: 10.0.3.10 matched 10.0.3.0/24 via eth1 (connected); also matched 10.0.0.0/16');
    // Every IPv4 frame on every link carries a valid header checksum.
    const ipFrames = events.filter((e): e is TxEvent => e.type === 'tx' && e.frame.eth.payload.kind === 'ipv4');
    expect(ipFrames.length).toBeGreaterThan(10);
    for (const e of ipFrames) expect(checksumValid(encodeEthernet(e.frame.eth).bytes, 14, 34)).toBe(true);
    // The request's TTL as it leaves each device.
    const reqTtl = ipFrames.filter((e) => e.cls === 'icmp-request' && e.flowId === ipFrames[0]!.flowId).map((e) => (e.frame.eth.payload as { ttl: number }).ttl);
    expect(reqTtl).toEqual([64, 63, 62, 61]);
  });

  it('TTL expiry → ICMP Time Exceeded from the router where it expired', () => {
    const { engine, events } = make(chainTopology());
    engine.ping('h1', '10.0.3.10', { count: 1, ttl: 2 });
    engine.runUntil(5 * SEC);
    expect(texts(events)).toContain('R2 dropped packet: TTL expired, sending ICMP Time Exceeded to 10.0.1.10');
    const drop = events.find((e): e is DropEvent => e.type === 'drop' && e.reason === 'ttl-expired');
    expect(drop?.node).toBe('r2');
    // Source of the error is R2's interface toward H1 (RFC 1812 4.3.2.4).
    expect(appLines(events)).toContain('H1 From 10.0.12.2 icmp_seq=1 Time to live exceeded');
    const err = events.find((e): e is TxEvent => e.type === 'tx' && e.cls === 'icmp-error')!;
    const bytes = encodeEthernet(err.frame.eth).bytes;
    const ipLen = (bytes[16]! << 8) | bytes[17]!;
    expect(checksumValid(bytes, 34, 14 + ipLen)).toBe(true); // ICMP checksum over the error
  });

  it('no route → ICMP Destination Net Unreachable', () => {
    const { engine, events } = make(chainTopology());
    engine.ping('h1', '172.16.5.5', { count: 1 }); // R1 default → R2, which has no route
    engine.runUntil(5 * SEC);
    expect(texts(events)).toContain('R2 has no route to 172.16.5.5');
    expect(appLines(events)).toContain('H1 From 10.0.12.2 icmp_seq=1 Destination Net Unreachable');
  });

  it('next-hop ARP failure → ICMP Destination Host Unreachable', () => {
    const { engine, events } = make(chainTopology());
    engine.ping('h1', '10.0.3.99', { count: 1, timeoutNs: 10 * SEC });
    engine.runUntil(10 * SEC);
    expect(texts(events)).toContain('R3 ARP for 10.0.3.99 failed after 3 attempts');
    // Error source = R3's interface toward H1 (RFC 1812 4.3.2.4), not the subnet's gateway address.
    expect(appLines(events)).toContain('H1 From 10.0.23.2 icmp_seq=1 Destination Host Unreachable');
  });

  it('answers pings to its own (far) interface address', () => {
    const { engine, events } = make(chainTopology());
    engine.ping('h1', '10.0.12.1', { count: 1 });
    engine.runUntil(3 * SEC);
    expect(appLines(events).some((l) => l.includes('bytes from 10.0.12.1') && l.includes('ttl=64'))).toBe(true);
  });

  it('host without a gateway cannot reach off-subnet destinations', () => {
    const { engine, events } = make(topo([host('h1', '10.0.0.1/24'), router('r1', { eth0: '10.0.0.254/24' })], [link('h1.eth0', 'r1.eth0')]));
    engine.ping('h1', '8.8.8.8', { count: 1 });
    engine.runUntil(3 * SEC);
    expect(appLines(events)).toContain('H1 From 10.0.0.1 icmp_seq=1 Network is unreachable (no default gateway)');
  });

  it('does not forward broadcasts', () => {
    const { engine, events } = make(chainTopology());
    engine.ping('h1', '10.0.3.255', { count: 1 }); // directed broadcast of the far subnet, via R1 default
    engine.runUntil(3 * SEC);
    expect(texts(events)).toContain('R3 does not forward broadcast to 10.0.3.255');
  });
});

describe('traceroute', () => {
  it('discovers each hop via Time Exceeded, then the destination via Echo Reply', () => {
    const { engine, events } = make(chainTopology());
    engine.traceroute('h1', '10.0.3.10');
    engine.runUntil(30 * SEC);
    const hops = events.filter((e) => e.type === 'app' && e.status === 'hop').map((e) => e.text.replace(/\d+\.\d{3} ms/g, 'T'));
    expect(hops).toEqual(['H1  1  10.0.1.1  T  T  T', 'H1  2  10.0.12.2  T  T  T', 'H1  3  10.0.23.2  T  T  T', 'H1  4  10.0.3.10  T  T  T']);
    expect(appLines(events)).toContain('H1 traceroute to 10.0.3.10 complete');
  });

  it('stops with !N when a router has no route', () => {
    const { engine, events } = make(chainTopology());
    engine.traceroute('h1', '172.16.5.5');
    engine.runUntil(30 * SEC);
    const hops = events.filter((e) => e.type === 'app' && e.status === 'hop').map((e) => e.text);
    expect(hops).toHaveLength(2);
    expect(hops[1]).toMatch(/^H1  2  10\.0\.12\.2  .* !N/);
  });
});

describe('determinism', () => {
  it('same topology + same commands → identical trace', () => {
    const run = () => {
      const { engine, events } = make(chainTopology(), 7);
      engine.traceroute('h1', '10.0.3.10');
      engine.ping('h2', '10.0.1.10', { count: 3 });
      engine.runUntil(30 * SEC);
      return events.map((e) => `${e.time} ${e.type} ${e.text}`);
    };
    const a = run();
    expect(a.length).toBeGreaterThan(100);
    expect(run()).toEqual(a);
  });
});
