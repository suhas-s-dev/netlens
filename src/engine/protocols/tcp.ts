/** TCP header encode/decode (RFC 9293). */
import type { Ipv4 } from './addr';
import { ByteReader, ByteWriter, hex } from './bytes';
import { l4Checksum, portName } from './l4';
import { IPPROTO_TCP, TCP_ACK, TCP_FIN, TCP_PSH, TCP_RST, TCP_SYN, TCP_URG, TCPOPT_EOL, TCPOPT_MSS, TCPOPT_NOP, type TcpOption, type TcpSegment } from './types';

const FLAG_NAMES: [number, string][] = [
  [TCP_URG, 'URG'],
  [TCP_ACK, 'ACK'],
  [TCP_PSH, 'PSH'],
  [TCP_RST, 'RST'],
  [TCP_SYN, 'SYN'],
  [TCP_FIN, 'FIN'],
];

export function tcpFlagNames(flags: number): string {
  return FLAG_NAMES.filter(([b]) => flags & b)
    .map(([, n]) => n)
    .join(', ');
}

function optionsBytes(opts: TcpOption[]): Uint8Array {
  const out: number[] = [];
  for (const o of opts) {
    if (o.kind === TCPOPT_EOL || o.kind === TCPOPT_NOP) out.push(o.kind);
    else if (o.kind === TCPOPT_MSS) out.push(TCPOPT_MSS, 4, ((o.mss ?? 0) >>> 8) & 0xff, (o.mss ?? 0) & 0xff);
    else out.push(o.kind, 2 + (o.raw?.length ?? 0), ...(o.raw ?? []));
  }
  while (out.length % 4) out.push(TCPOPT_EOL);
  return Uint8Array.from(out);
}

function write(w: ByteWriter, s: TcpSegment, spans: boolean): void {
  const L = 'TCP' as const;
  const base = w.length;
  const f = (key: string, label: string, display: string, fn: () => void) => (spans ? w.field(L, key, label, display, fn) : fn());
  f('tcp.sport', 'Source port', portName(s.srcPort), () => w.u16(s.srcPort));
  f('tcp.dport', 'Destination port', portName(s.dstPort), () => w.u16(s.dstPort));
  f('tcp.seq', 'Sequence number', `${s.seq >>> 0}`, () => w.u32(s.seq));
  f('tcp.ack', 'Acknowledgment number', s.flags & TCP_ACK ? `${s.ack >>> 0}` : `${s.ack >>> 0} (not used: ACK flag clear)`, () => w.u32(s.ack));
  w.u16(((s.dataOffset & 0xf) << 12) | (s.flags & 0x1ff));
  if (spans) {
    w.bitField(L, 'tcp.doff', 'Header length', `${s.dataOffset * 4} bytes (${s.dataOffset})`, base + 12, base + 13, '1111 ....');
    w.bitField(L, 'tcp.flags', 'Flags', `${hex(s.flags, 3)} (${tcpFlagNames(s.flags) || 'none'})`, base + 12, base + 14, '.... ...1 1111 1111');
  }
  f('tcp.window', 'Window', `${s.window} bytes the receiver can accept`, () => w.u16(s.window));
  f('tcp.checksum', 'Checksum', hex(s.checksum, 4), () => w.u16(s.checksum));
  f('tcp.urgent', 'Urgent pointer', String(s.urgent), () => w.u16(s.urgent));
  if (s.options.length) {
    const ob = optionsBytes(s.options);
    const mss = s.options.find((o) => o.kind === TCPOPT_MSS);
    f('tcp.options', 'Options', mss ? `MSS = ${mss.mss} bytes${ob.length > 4 ? ' + padding' : ''}` : `${ob.length} bytes`, () => w.bytes(ob));
  }
  if (s.data.length) f('tcp.data', 'Data', `${s.data.length} bytes`, () => w.bytes(s.data));
}

export function encodeTcp(w: ByteWriter, s: TcpSegment): void {
  w.layer('TCP', () => write(w, s, true));
}

export function tcpBytes(s: TcpSegment): Uint8Array {
  const w = new ByteWriter(s.dataOffset * 4 + s.data.length);
  write(w, s, false);
  return w.toBytes();
}

export function tcpLength(s: TcpSegment): number {
  return s.dataOffset * 4 + s.data.length;
}

export function decodeTcp(r: ByteReader): TcpSegment {
  const start = r.pos;
  const srcPort = r.u16();
  const dstPort = r.u16();
  const seq = r.u32();
  const ack = r.u32();
  const of = r.u16();
  const dataOffset = of >>> 12;
  const flags = of & 0x1ff;
  const window = r.u16();
  const checksum = r.u16();
  const urgent = r.u16();
  const optEnd = start + dataOffset * 4;
  const options: TcpOption[] = [];
  while (r.pos < optEnd) {
    const kind = r.u8();
    if (kind === TCPOPT_EOL) {
      // Remaining option bytes are padding.
      r.pos = optEnd;
      options.push({ kind });
      break;
    }
    if (kind === TCPOPT_NOP) {
      options.push({ kind });
      continue;
    }
    const len = r.u8();
    if (kind === TCPOPT_MSS && len === 4) options.push({ kind, mss: r.u16() });
    else options.push({ kind, raw: r.bytes(Math.max(0, len - 2)) });
  }
  r.pos = optEnd;
  // EOL padding is implied by dataOffset: drop it so encode/decode round-trips.
  while (options.length && options[options.length - 1]!.kind === TCPOPT_EOL) options.pop();
  const data = r.rest();
  return { kind: 'tcp', srcPort, dstPort, seq, ack, dataOffset, flags, window, checksum, urgent, options, data };
}

export interface MakeTcp {
  srcPort: number;
  dstPort: number;
  seq: number;
  ack: number;
  flags: number;
  window: number;
  mss?: number;
  data?: Uint8Array;
}

export function makeTcp(src: Ipv4, dst: Ipv4, o: MakeTcp): TcpSegment {
  const options: TcpOption[] = o.mss !== undefined ? [{ kind: TCPOPT_MSS, mss: o.mss }] : [];
  const s: TcpSegment = {
    kind: 'tcp',
    srcPort: o.srcPort,
    dstPort: o.dstPort,
    seq: o.seq >>> 0,
    ack: o.ack >>> 0,
    dataOffset: 5 + optionsBytes(options).length / 4,
    flags: o.flags,
    window: o.window,
    checksum: 0,
    urgent: 0,
    options,
    data: o.data ?? new Uint8Array(0),
  };
  s.checksum = l4Checksum(src, dst, IPPROTO_TCP, tcpBytes(s));
  return s;
}

export function tcpChecksumValid(src: Ipv4, dst: Ipv4, s: TcpSegment): boolean {
  return l4Checksum(src, dst, IPPROTO_TCP, tcpBytes(s)) === 0;
}
