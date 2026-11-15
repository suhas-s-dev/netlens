import { describe, expect, it } from 'vitest';
import mtuPreset from '../../presets/mtu-bottleneck.json';
import tcpPreset from '../../presets/tcp-udp.json';
import { SEC } from '../core/time';
import type { HostState } from '../devices/state';
import type { TopologyJson } from '../model/topology';
import { decodeEthernet, encodeEthernet } from '../protocols/ethernet';
import { makeIpv4 } from '../protocols/ipv4';
import { makeTcp, tcpChecksumValid } from '../protocols/tcp';
import { ETHERTYPE_IPV4, IPPROTO_TCP, IPPROTO_UDP, IPV4_FLAG_DF, TCP_ACK, TCP_FIN, TCP_RST, TCP_SYN, type EthernetFrame, type Ipv4Packet, type TcpSegment } from '../protocols/types';
import { makeUdp, udpChecksumValid } from '../protocols/udp';
import type { TableEvent, TxEvent } from '../trace/events';
import { appLines, make, texts } from './helpers';

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const eth = (payload: Ipv4Packet): EthernetFrame => ({ dst: '02:00:00:00:00:02', src: '02:00:00:00:00:01', etherType: ETHERTYPE_IPV4, payload });

describe('UDP / TCP checksums (pseudo-header, independently computed vectors)', () => {
  it('UDP 10.0.1.10:49152 → 10.0.2.80:7 "hello" = 0xe4a0', () => {
    const u = makeUdp('10.0.1.10', '10.0.2.80', 49152, 7, ascii('hello'));
    expect(u.checksum).toBe(0xe4a0);
    expect(udpChecksumValid('10.0.1.10', '10.0.2.80', u)).toBe(true);
    expect(udpChecksumValid('10.0.1.11', '10.0.2.80', u)).toBe(false); // pseudo-header covers the IPs
  });

  it('TCP SYN with MSS 1460 = 0xbc76', () => {
    const s = makeTcp('10.0.1.10', '10.0.2.80', { srcPort: 49152, dstPort: 80, seq: 0x01020304, ack: 0, flags: TCP_SYN, window: 65535, mss: 1460 });
    expect(s.dataOffset).toBe(6);
    expect(s.checksum).toBe(0xbc76);
    expect(tcpChecksumValid('10.0.1.10', '10.0.2.80', s)).toBe(true);
  });

  it('round-trips UDP and TCP (options, data, flags) through real bytes', () => {
    const u = makeIpv4({ src: '10.0.1.10', dst: '10.0.2.80', protocol: IPPROTO_UDP, identification: 1, payload: makeUdp('10.0.1.10', '10.0.2.80', 5000, 53, ascii('query')) });
    expect(decodeEthernet(encodeEthernet(eth(u)).bytes)).toEqual(eth(u));
    for (const opts of [
      { flags: TCP_SYN, mss: 1460 },
      { flags: TCP_ACK | TCP_FIN },
      { flags: TCP_ACK, data: ascii('GET / HTTP/1.0\r\n\r\n') },
      { flags: TCP_RST | TCP_ACK },
    ]) {
      const t = makeIpv4({ src: '10.0.1.10', dst: '10.0.2.80', protocol: IPPROTO_TCP, identification: 2, flags: IPV4_FLAG_DF, payload: makeTcp('10.0.1.10', '10.0.2.80', { srcPort: 49152, dstPort: 80, seq: 0xfffffff0, ack: 77, window: 65535, ...opts }) });
      const enc = encodeEthernet(eth(t));
      expect(decodeEthernet(enc.bytes)).toEqual(eth(t));
      expect(enc.layers.map((l) => l.layer)).toEqual(['Ethernet II', 'IPv4', 'TCP']);
    }
  });
});

function run(t: TopologyJson, until: number, seed = 1) {
  const { engine, events } = make(t, seed);
  engine.runUntil(until);
  return { engine, events };
}

const tcpTx = (events: ReturnType<typeof run>['events'], from?: string) =>
  events.filter((e): e is TxEvent => e.type === 'tx' && e.frame.eth.payload.kind === 'ipv4' && e.frame.eth.payload.payload.kind === 'tcp' && (!from || e.node === from));
const seg = (e: TxEvent) => (e.frame.eth.payload as Ipv4Packet).payload as TcpSegment;

describe('TCP connection', () => {
  const preset = tcpPreset as TopologyJson;

  it('3-way handshake: SYN (MSS) → SYN-ACK (ack = ISN+1) → ACK', () => {
    const { events } = run(preset, 2 * SEC);
    const [syn, synack, ack] = [tcpTx(events, 'h1')[0]!, tcpTx(events, 'web')[0]!, tcpTx(events, 'h1')[1]!].map(seg);
    expect(syn!.flags).toBe(TCP_SYN);
    expect(syn!.options).toEqual([{ kind: 2, mss: 1460 }]);
    expect(synack!.flags).toBe(TCP_SYN | TCP_ACK);
    expect(synack!.ack).toBe((syn!.seq + 1) >>> 0);
    expect(ack!.flags).toBe(TCP_ACK);
    expect(ack!.ack).toBe((synack!.seq + 1) >>> 0);
    expect(ack!.seq).toBe((syn!.seq + 1) >>> 0);
  });

  it('segments the response by MSS, with DF set and no IP fragments', () => {
    const { events } = run(preset, 2 * SEC);
    const data = tcpTx(events, 'web').map(seg).filter((s) => s.data.length);
    expect(data.map((s) => s.data.length)).toEqual([1460, 1460, 1080]);
    for (const e of tcpTx(events)) expect((e.frame.eth.payload as Ipv4Packet).flags & IPV4_FLAG_DF).toBeTruthy();
    expect(events.some((e) => e.type === 'tx' && e.cls === 'fragment' && e.time < 2 * SEC)).toBe(false);
    expect(appLines(events)).toContain('H1 server closed after sending 4000 bytes in 3 segments; closing our side');
  });

  it('walks both sides through the state machine, including TIME_WAIT', () => {
    const { events } = run(preset, 2.4 * SEC);
    const states = (node: string) =>
      events
        .filter((e): e is TableEvent => e.type === 'table' && e.table === 'tcp' && e.node === node && e.key.includes(':80'))
        .map((e) => /→ (\w+)\]$/.exec(e.text)![1]);
    expect(states('h1')).toEqual(['SYN_SENT', 'ESTABLISHED', 'CLOSE_WAIT', 'LAST_ACK', 'CLOSED']);
    expect(states('web')).toEqual(['SYN_RCVD', 'ESTABLISHED', 'FIN_WAIT_1', 'FIN_WAIT_2', 'TIME_WAIT']);
    const { events: later } = run(preset, 4.2 * SEC);
    expect(texts(later)).toContain('WEB TIME_WAIT over: connection closed [TIME_WAIT → CLOSED]');
  });

  it('a closed port answers RST: "connection refused"', () => {
    const { events } = run(preset, 3 * SEC);
    const rst = tcpTx(events, 'web').map(seg).find((s) => s.flags & TCP_RST)!;
    expect(rst.flags).toBe(TCP_RST | TCP_ACK);
    expect(appLines(events)).toContain('H1 Connection refused: 10.0.2.80 answered RST (port 22 closed)');
  });

  it('recovers from loss with duplicate ACKs, fast retransmit and RTO backoff, delivering every byte', () => {
    const { events } = run(preset, 20 * SEC);
    const t = texts(events);
    expect(events.filter((e) => e.type === 'drop' && e.reason === 'link-loss').length).toBeGreaterThan(2);
    expect(t.some((x) => x.includes('(duplicate ACK)'))).toBe(true);
    expect(t.some((x) => x.includes('fast retransmit'))).toBe(true);
    expect(t.some((x) => /retransmission timeout after 200 ms/.test(x)) && t.some((x) => /retransmission timeout after 400 ms/.test(x))).toBe(true);
    expect(appLines(events)).toContain('H1 server closed after sending 8000 bytes in 6 segments; closing our side');
  });

  it('lowers the MSS when a router reports a smaller path MTU (TCP + PMTUD), so nothing is fragmented', () => {
    const t: TopologyJson = { ...(mtuPreset as TopologyJson), scenario: [{ at: 0, action: 'tcp', node: 'h1', dst: '10.0.2.20', bytes: 4000 }] };
    const { engine, events } = run(t, 5 * SEC);
    expect(texts(events).some((x) => /H2 lowers MSS for 10\.0\.1\.10:\d+ from 1460 to 1360 \(ICMP Fragmentation Needed, path MTU 1400\)/.test(x))).toBe(true);
    const wan = tcpTx(events).filter((e) => e.link === 'l2');
    for (const e of wan) expect((e.frame.eth.payload as Ipv4Packet).totalLength).toBeLessThanOrEqual(1400);
    expect(events.some((e) => e.type === 'tx' && e.cls === 'fragment')).toBe(false);
    expect(appLines(events).some((l) => /server closed after sending 4000 bytes/.test(l))).toBe(true);
    expect((engine.getState('h2') as HostState).pmtu[0]).toMatchObject({ dst: '10.0.1.10', mtu: 1400 });
  });
});

describe('UDP', () => {
  const preset = tcpPreset as TopologyJson;

  it('echo (port 7) answers; a closed port gets ICMP Port Unreachable', () => {
    const { events } = run(preset, 5 * SEC);
    const lines = appLines(events);
    expect(lines.filter((l) => /64 bytes back from 10\.0\.2\.80:7/.test(l))).toHaveLength(2);
    expect(lines).toContain('H1 From 10.0.2.80: port 53 unreachable (nothing listening)');
    const icmp = events.find((e): e is TxEvent => e.type === 'tx' && e.node === 'web' && e.cls === 'icmp-error')!;
    expect((icmp.frame.eth.payload as Ipv4Packet).payload).toMatchObject({ type: 3, code: 3 });
  });

  it('a 3000-byte datagram cannot be segmented, so IP fragments it (segmentation vs fragmentation)', () => {
    const { events } = run(preset, 6.5 * SEC);
    const frags = events.filter((e) => e.type === 'tx' && e.cls === 'fragment' && e.node === 'h1');
    expect(frags).toHaveLength(3); // 3008 bytes of UDP (8 + 3000) in a 3028-byte packet: 1480 + 1480 + 48 data bytes
    expect(appLines(events)).toContain(appLines(events).find((l) => /3000 bytes back from 10\.0\.2\.80:7/.test(l)));
  });
});
