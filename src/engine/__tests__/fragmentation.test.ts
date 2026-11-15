import { describe, expect, it } from 'vitest';
import mtuPreset from '../../presets/mtu-bottleneck.json';
import { SEC } from '../core/time';
import type { Host } from '../devices/Host';
import type { HostState } from '../devices/state';
import type { TopologyJson } from '../model/topology';
import { checksumValid } from '../protocols/checksum';
import { decodeEthernet, encodeEthernet } from '../protocols/ethernet';
import { makeEcho } from '../protocols/icmp';
import { fragment, makeIpv4, payloadBytes } from '../protocols/ipv4';
import { ETHERTYPE_IPV4, IPPROTO_ICMP, IPV4_FLAG_MF, type EthernetFrame, type Ipv4Packet } from '../protocols/types';
import type { DropEvent, TxEvent } from '../trace/events';
import { appLines, make, texts } from './helpers';

const preset = mtuPreset as TopologyJson;

/** The 4404-byte datagram from the exercise: 20-byte header + 4384 bytes of ICMP. */
function big(): Ipv4Packet {
  const data = new Uint8Array(4384 - 8).map((_, i) => i & 0xff);
  return makeIpv4({ src: '10.0.1.10', dst: '10.0.2.20', protocol: IPPROTO_ICMP, identification: 0x1234, payload: makeEcho(8, 7, 1, data) });
}

describe('RFC 791 fragmentation', () => {
  it('splits a 4404-byte packet for MTU 1500 exactly like the textbook exercise', () => {
    const p = big();
    expect(p.totalLength).toBe(4404);
    const f = fragment(p, 1500);
    expect(f.map((x) => x.totalLength)).toEqual([1500, 1500, 1444]);
    expect(f.map((x) => x.fragmentOffset)).toEqual([0, 185, 370]); // 0/8, 1480/8, 2960/8
    expect(f.map((x) => (x.flags & IPV4_FLAG_MF ? 1 : 0))).toEqual([1, 1, 0]);
    expect(new Set(f.map((x) => x.identification))).toEqual(new Set([0x1234]));
    // Third fragment carries data bytes 2960–4383 (1424 bytes).
    expect(f[2]!.totalLength - 20).toBe(1424);
    // Reassembling the slices gives back the original payload.
    const whole = new Uint8Array(4384);
    for (const x of f) whole.set(payloadBytes(x), x.fragmentOffset * 8);
    expect(whole).toEqual(payloadBytes(p));
    for (const x of f) {
      const bytes = encodeEthernet({ dst: '02:00:00:00:00:02', src: '02:00:00:00:00:01', etherType: ETHERTYPE_IPV4, payload: x }).bytes;
      expect(checksumValid(bytes, 14, 34)).toBe(true);
    }
  });

  it('re-fragments fragments with offsets relative to the original datagram', () => {
    const f = fragment(big(), 1500).flatMap((x) => fragment(x, 1400));
    expect(f.map((x) => x.fragmentOffset)).toEqual([0, 172, 185, 357, 370, 542]);
    expect(f.map((x) => (x.flags & IPV4_FLAG_MF ? 1 : 0))).toEqual([1, 1, 1, 1, 1, 0]);
    expect(f.every((x) => x.totalLength <= 1400)).toBe(true);
  });

  it('fragments survive encode/decode as raw slices', () => {
    for (const x of fragment(big(), 1500)) {
      const eth: EthernetFrame = { dst: '02:00:00:00:00:02', src: '02:00:00:00:00:01', etherType: ETHERTYPE_IPV4, payload: x };
      const enc = encodeEthernet(eth);
      expect(decodeEthernet(enc.bytes)).toEqual(eth);
      expect(enc.fields.find((s) => s.key === 'data.fragment')?.display).toMatch(/of the original payload/);
    }
  });
});

describe('MTU bottleneck preset', () => {
  function run(until = 12 * SEC) {
    const { engine, events } = make(preset, 1);
    engine.runUntil(until);
    return { engine, events };
  }

  it('source fragments, a router re-fragments, the destination reassembles, the ping succeeds', () => {
    const { events } = run(1.9 * SEC);
    const t = texts(events);
    expect(t).toContain("H1 4404-byte packet won't fit eth0's MTU 1500: split into 3 fragments (offsets 0, 185, 370, sizes 1500, 1500, 1444 bytes)");
    expect(t.some((x) => x.startsWith("R1 1500-byte packet won't fit eth1's MTU 1400: split into 2 fragments (offsets 0, 172"))).toBe(true);
    expect(t).toContain('H2 reassembled 6 fragments into the original 4404-byte packet (id=' + t.find((x) => x.startsWith('H2 reassembled'))!.split('id=')[1]);
    // Nothing bigger than 1400 bytes ever crossed the WAN link.
    const wan = events.filter((e): e is TxEvent => e.type === 'tx' && e.link === 'l2');
    expect(wan.length).toBeGreaterThan(6);
    for (const e of wan) if (e.frame.eth.payload.kind === 'ipv4') expect(e.frame.eth.payload.totalLength).toBeLessThanOrEqual(1400);
    expect(appLines(events).some((l) => /4376 bytes from 10\.0\.2\.20/.test(l))).toBe(true);
  });

  it('DF + too big → ICMP Fragmentation Needed carrying MTU 1400, and the host caches the path MTU', () => {
    const { engine, events } = run(2.9 * SEC);
    const drop = events.find((e): e is DropEvent => e.type === 'drop' && e.reason === 'too-big');
    expect(drop?.node).toBe('r1');
    const err = events.find((e): e is TxEvent => e.type === 'tx' && e.node === 'r1' && e.cls === 'icmp-error')!;
    const ip = err.frame.eth.payload as Ipv4Packet;
    const icmp = ip.payload as { type: number; code: number; unused: number };
    expect([icmp.type, icmp.code, icmp.unused & 0xffff]).toEqual([3, 4, 1400]);
    // Bytes 6-7 of the ICMP header hold the next-hop MTU (RFC 1191).
    const bytes = encodeEthernet(err.frame.eth).bytes;
    expect((bytes[34 + 6]! << 8) | bytes[34 + 7]!).toBe(1400);
    expect(appLines(events)).toContain('H1 From 10.0.1.1 icmp_seq=1 Frag needed and DF set (mtu = 1400)');
    expect((engine.getState('h1') as HostState).pmtu).toEqual([expect.objectContaining({ dst: '10.0.2.20', mtu: 1400 })]);
    // A second DF ping that is too big now fails locally, without touching the network.
    engine.ping('h1', '10.0.2.20', { count: 1, size: 1472, df: true });
    engine.runFor(10_000_000);
    expect(appLines(events)).toContain('H1 From 10.0.1.10 icmp_seq=1 Message too long (mtu = 1400)');
  });

  it('PMTUD finds the 1400-byte bottleneck', () => {
    const { events } = run(4.9 * SEC);
    const lines = appLines(events).filter((l) => l.startsWith('H2'));
    expect(lines).toContain('H2 10.0.2.1 says: too big, next-hop MTU 1400');
    expect(lines).toContain('H2 path MTU to 10.0.1.10 = 1400');
  });

  it('MTR reports every hop with no loss', () => {
    const { events } = run(12 * SEC);
    const rows = appLines(events).filter((l) => /^H1\s+\d\./.test(l));
    expect(rows.map((r) => r.split(/\s+/)[2])).toEqual(['10.0.1.1', '10.0.12.2', '10.0.2.20']);
    for (const r of rows) expect(r).toMatch(/ 0\.0%/);
    expect(appLines(events)).toContain('H1 mtr to 10.0.2.20 complete');
  });
});

describe('reassembly timeout', () => {
  it('drops an incomplete datagram after 30 s and reports Time Exceeded (code 1)', () => {
    const { engine, events } = make(preset, 1);
    const h2 = engine.devices.get('h2') as Host;
    const frags = fragment(big(), 1500);
    const port = h2.ports.get('eth0')!;
    // Deliver only the first fragment, straight into H2's NIC.
    h2.receive(port, { id: 'x1', flowId: 'fx', eth: { dst: port.mac, src: '02:00:00:00:03:02', etherType: ETHERTYPE_IPV4, payload: frags[0]! } });
    engine.runUntil(31 * SEC);
    expect(texts(events)).toContain('H2 gave up reassembling packet id=4660 from 10.0.1.10: fragments missing after 30 s');
    const te = events.find((e): e is TxEvent => e.type === 'tx' && e.node === 'h2' && e.cls === 'icmp-error');
    expect((te!.frame.eth.payload as Ipv4Packet).payload).toMatchObject({ type: 11, code: 1 });
  });
});

describe('link loss', () => {
  const lossy = (pct: number): TopologyJson => ({ ...preset, scenario: [{ at: 0, action: 'ping', node: 'h1', dst: '10.0.2.20', count: 20, intervalMs: 50 }], links: preset.links.map((l) => (l.id === 'l2' ? { ...l, lossPercent: pct } : l)) });

  it('drops frames at the configured rate, deterministically per seed', () => {
    const run = () => {
      const { engine, events } = make(lossy(30), 5);
      engine.runUntil(5 * SEC);
      return events.filter((e) => e.type === 'drop' && e.reason === 'link-loss').map((e) => e.packetId);
    };
    const a = run();
    expect(a.length).toBeGreaterThan(3);
    expect(run()).toEqual(a);
    const { engine, events } = make(lossy(0), 5);
    engine.runUntil(5 * SEC);
    expect(events.some((e) => e.type === 'drop' && e.reason === 'link-loss')).toBe(false);
  });

  it('MTR shows the loss', () => {
    const t: TopologyJson = { ...lossy(40), scenario: [{ at: 0, action: 'mtr', node: 'h1', dst: '10.0.2.20', rounds: 10 }] };
    const { engine, events } = make(t, 3);
    engine.runUntil(60 * SEC);
    const last = appLines(events).filter((l) => /^H1\s+\d\./.test(l)).pop()!;
    expect(last).toMatch(/10\.0\.2\.20/);
    expect(Number(/(\d+\.\d)%/.exec(last)![1])).toBeGreaterThan(0);
  });
});
