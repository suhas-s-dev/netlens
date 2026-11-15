import { describe, expect, it } from 'vitest';
import routerChain from '../../presets/router-chain.json';
import singleLan from '../../presets/single-lan.json';
import twoLans from '../../presets/two-lans.json';
import mtuBottleneck from '../../presets/mtu-bottleneck.json';
import { SEC } from '../core/time';
import type { TopologyJson } from '../model/topology';
import { validateTopology } from '../topology/validate';
import { appLines, formatTrace, make, texts } from './helpers';

const presets: [string, TopologyJson][] = [
  ['single-lan', singleLan as TopologyJson],
  ['two-lans', twoLans as TopologyJson],
  ['router-chain', routerChain as TopologyJson],
  ['mtu-bottleneck', mtuBottleneck as TopologyJson],
];

function run(t: TopologyJson) {
  const { engine, events } = make(t, t.seed);
  engine.runUntil(20 * SEC);
  return { engine, events };
}

describe.each(presets)('preset %s', (name, topology) => {
  it('validates with no errors or warnings', () => {
    expect(validateTopology(topology)).toEqual([]);
  });

  it('produces an identical trace on every run (snapshot)', () => {
    const a = formatTrace(run(topology).events);
    expect(formatTrace(run(topology).events)).toBe(a);
    expect(a).toMatchSnapshot(name);
  });
});

describe('preset behaviour', () => {
  it('single LAN: ARP flood, MAC learning, then unicast only', () => {
    const { events } = run(singleLan as TopologyJson);
    const t = texts(events);
    expect(t).toContain('SW1 flooding broadcast frame out ports 2,3');
    expect(t).toContain('SW1 learned 02:00:00:00:01:01 on port 1');
    expect(t).toContain('SW1 learned 02:00:00:00:03:01 on port 3');
    expect(appLines(events).filter((l) => l.includes('bytes from'))).toHaveLength(3);
  });

  it('two LANs: gateway ARP on each segment, routing between them', () => {
    const { events } = run(twoLans as TopologyJson);
    const t = texts(events);
    expect(t).toContain('H1: 10.0.2.15 is outside 10.0.1.0/24, sending via default gateway 10.0.1.1');
    expect(t).toContain('H1 broadcasting ARP request: who has 10.0.1.1? tell 10.0.1.10 (attempt 1/3)');
    expect(t).toContain('R1 broadcasting ARP request: who has 10.0.2.15? tell 10.0.2.1 (attempt 1/3)');
    expect(t).toContain('R1 LPM: 10.0.2.15 matched 10.0.2.0/24 via eth1 (connected)');
    // ARP never crosses the router: no device on LAN B sees H1's request for the gateway.
    expect(events.some((e) => e.type === 'tx' && e.cls === 'arp' && e.text.includes('Who has 10.0.1.1') && ['sw2', 'h3', 'h4'].includes(e.toNode))).toBe(false);
    expect(appLines(events).filter((l) => l.includes('bytes from'))).toHaveLength(3);
  });

  it('router chain: traceroute hops, then an unreachable destination', () => {
    const { events } = run(routerChain as TopologyJson);
    const hops = events.filter((e) => e.type === 'app' && e.status === 'hop').map((e) => e.text.split('  ').slice(0, 3).join('  '));
    expect(hops).toEqual(['H1  1  10.0.1.1', 'H1  2  10.0.12.2', 'H1  3  10.0.23.2', 'H1  4  10.0.3.10']);
    expect(texts(events)).toContain('R1 dropped packet: TTL expired, sending ICMP Time Exceeded to 10.0.1.10');
    expect(texts(events)).toContain('R2 has no route to 10.0.99.1');
    expect(appLines(events)).toContain('H1 From 10.0.12.2 icmp_seq=1 Destination Net Unreachable');
  });
});

describe('validation', () => {
  const base = (): TopologyJson => JSON.parse(JSON.stringify(twoLans));

  it('flags a gateway outside the host subnet', () => {
    const t = base();
    (t.nodes[0] as { gateway: string }).gateway = '10.0.2.1';
    expect(validateTopology(t).map((i) => i.message)).toContain('H1: gateway 10.0.2.1 is outside its subnet 10.0.1.0/24');
  });

  it('flags duplicate IPs', () => {
    const t = base();
    t.nodes[1]!.interfaces[0]!.ip = '10.0.1.10/24';
    expect(validateTopology(t).map((i) => i.message)).toContain('Duplicate IP 10.0.1.10: H1 eth0 and H2 eth0');
  });

  it('flags overlapping subnets on a router and across LANs', () => {
    const t = base();
    t.nodes[3]!.interfaces[1]!.ip = '10.0.0.1/16';
    const msgs = validateTopology(t).map((i) => i.message);
    expect(msgs).toContain('R1: eth0 (10.0.1.0/24) and eth1 (10.0.0.0/16) overlap');
    expect(msgs.some((m) => m.startsWith('Subnet') && m.includes('overlaps'))).toBe(true);
  });

  it('flags network/broadcast addresses, bad CIDR, and unreachable next hops', () => {
    const t = base();
    t.nodes[0]!.interfaces[0]!.ip = '10.0.1.255/24';
    t.nodes[1]!.interfaces[0]!.ip = '10.0.1/24';
    (t.nodes[3] as { staticRoutes: unknown[] }).staticRoutes = [{ prefix: '192.168.0.0/16', nextHop: '172.16.0.1' }];
    const msgs = validateTopology(t).map((i) => i.message);
    expect(msgs).toContain('H1 eth0: 10.0.1.255 is the broadcast address of 10.0.1.0/24');
    expect(msgs).toContain('H2 eth0: "10.0.1/24" is not a valid address/prefix (e.g. 10.0.0.1/24)');
    expect(msgs).toContain('R1: next hop 172.16.0.1 for 192.168.0.0/16 is not on any connected subnet');
  });
});
