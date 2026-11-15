/** IPv4 (RFC 791). No fragmentation in the MVP: we always send with DF clear, MF clear, offset 0,
 * and our MTU (1500) is never exceeded by the traffic we generate. */
import { bytesToIp, ipToBytes, type Ipv4 } from './addr';
import { ByteReader, ByteWriter, hex } from './bytes';
import { internetChecksum } from './checksum';
import { decodeIcmp, encodeIcmp, icmpLength } from './icmp';
import { IPPROTO_ICMP, IPV4_FLAG_DF, IPV4_FLAG_MF, type Ipv4Packet, type Ipv4Payload } from './types';

export const DEFAULT_TTL = 64;

const PROTO_NAMES: Record<number, string> = { 1: 'ICMP', 6: 'TCP', 17: 'UDP' };

export function protoName(p: number): string {
  return PROTO_NAMES[p] ?? `proto ${p}`;
}

export function payloadLength(p: Ipv4Payload): number {
  return p.kind === 'raw' ? p.bytes.length : icmpLength(p);
}

function flagsDisplay(flags: number): string {
  const parts: string[] = [];
  if (flags & IPV4_FLAG_DF) parts.push("Don't fragment");
  if (flags & IPV4_FLAG_MF) parts.push('More fragments');
  return `${hex(flags, 1)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
}

function writeHeader(w: ByteWriter, p: Ipv4Packet, withSpans: boolean): void {
  const L = 'IPv4' as const;
  const base = w.length;
  const f = (key: string, label: string, display: string, fn: () => void) =>
    withSpans ? w.field(L, key, label, display, fn) : fn();
  w.u8((p.version << 4) | (p.ihl & 0x0f));
  if (withSpans) {
    w.bitField(L, 'ipv4.version', 'Version', String(p.version), base, base + 1, '1111 ....');
    w.bitField(L, 'ipv4.ihl', 'Header length', `${p.ihl * 4} bytes (${p.ihl})`, base, base + 1, '.... 1111');
  }
  w.u8((p.dscp << 2) | (p.ecn & 0x3));
  if (withSpans) {
    w.bitField(L, 'ipv4.dscp', 'DSCP', String(p.dscp), base + 1, base + 2, '1111 11..');
    w.bitField(L, 'ipv4.ecn', 'ECN', String(p.ecn), base + 1, base + 2, '.... ..11');
  }
  f('ipv4.len', 'Total length', String(p.totalLength), () => w.u16(p.totalLength));
  f('ipv4.id', 'Identification', `${hex(p.identification, 4)} (${p.identification})`, () => w.u16(p.identification));
  w.u16(((p.flags & 0x7) << 13) | (p.fragmentOffset & 0x1fff));
  if (withSpans) {
    w.bitField(L, 'ipv4.flags', 'Flags', flagsDisplay(p.flags), base + 6, base + 8, '111. ....');
    w.bitField(L, 'ipv4.frag', 'Fragment offset', String(p.fragmentOffset), base + 6, base + 8, '...1 1111 1111 1111');
  }
  f('ipv4.ttl', 'Time to live', String(p.ttl), () => w.u8(p.ttl));
  f('ipv4.proto', 'Protocol', `${protoName(p.protocol)} (${p.protocol})`, () => w.u8(p.protocol));
  f('ipv4.checksum', 'Header checksum', hex(p.checksum, 4), () => w.u16(p.checksum));
  f('ipv4.src', 'Source address', p.src, () => w.bytes(ipToBytes(p.src)));
  f('ipv4.dst', 'Destination address', p.dst, () => w.bytes(ipToBytes(p.dst)));
  if (p.options.length) f('ipv4.options', 'Options', `${p.options.length} bytes`, () => w.bytes(p.options));
}

export function computeIpv4Checksum(p: Ipv4Packet): number {
  const w = new ByteWriter(p.ihl * 4);
  writeHeader(w, { ...p, checksum: 0 }, false);
  return internetChecksum(w.toBytes());
}

export function encodeIpv4(w: ByteWriter, p: Ipv4Packet): void {
  w.layer('IPv4', () => writeHeader(w, p, true));
  if (p.payload.kind === 'raw') {
    const bytes = p.payload.bytes;
    if (bytes.length) {
      if (isFragment(p)) {
        const from = p.fragmentOffset * 8;
        w.field('Data', 'data.fragment', 'Fragment data', `${bytes.length} bytes = bytes ${from}–${from + bytes.length - 1} of the original payload`, () => w.bytes(bytes));
      } else {
        w.field('Data', 'data', 'Data', `${bytes.length} bytes`, () => w.bytes(bytes));
      }
    }
  } else {
    encodeIcmp(w, p.payload);
  }
}

/** Encode just this IP datagram (header + payload), no Ethernet. Used to quote it in ICMP errors. */
export function encodeIpv4Datagram(p: Ipv4Packet): Uint8Array {
  const w = new ByteWriter(p.totalLength);
  encodeIpv4(w, p);
  return w.toBytes();
}

export function decodeIpv4(r: ByteReader): Ipv4Packet {
  const start = r.pos;
  const vihl = r.u8();
  const version = vihl >>> 4;
  const ihl = vihl & 0x0f;
  if (version !== 4) throw new Error(`Not IPv4 (version ${version})`);
  if (ihl < 5) throw new Error(`Invalid IHL ${ihl}`);
  const tos = r.u8();
  const totalLength = r.u16();
  const identification = r.u16();
  const ff = r.u16();
  const ttl = r.u8();
  const protocol = r.u8();
  const checksum = r.u16();
  const src = bytesToIp(r.bytes(4));
  const dst = bytesToIp(r.bytes(4));
  const options = r.bytes(ihl * 4 - 20);
  // Ethernet may pad short frames: the datagram ends at totalLength, not at the buffer end.
  const payloadEnd = start + totalLength;
  if (payloadEnd > r.end) throw new RangeError(`IPv4 total length ${totalLength} exceeds buffer`);
  const pr = new ByteReader(r.buf, r.pos, payloadEnd);
  const flags = ff >>> 13;
  const fragmentOffset = ff & 0x1fff;
  // A fragment carries only a slice of the upper-layer message: keep it as raw bytes.
  const fragmented = (flags & IPV4_FLAG_MF) !== 0 || fragmentOffset > 0;
  const payload: Ipv4Payload = protocol === IPPROTO_ICMP && !fragmented ? decodeIcmp(pr) : { kind: 'raw', bytes: pr.rest() };
  r.pos = payloadEnd;
  return {
    kind: 'ipv4',
    version,
    ihl,
    dscp: tos >>> 2,
    ecn: tos & 3,
    totalLength,
    identification,
    flags,
    fragmentOffset,
    ttl,
    protocol,
    checksum,
    src,
    dst,
    options,
    payload,
  };
}

export interface MakeIpv4Opts {
  src: Ipv4;
  dst: Ipv4;
  protocol: number;
  identification: number;
  payload: Ipv4Payload;
  ttl?: number;
  flags?: number;
  dscp?: number;
}

/** Build a datagram with correct total length and header checksum. */
export function makeIpv4(o: MakeIpv4Opts): Ipv4Packet {
  const p: Ipv4Packet = {
    kind: 'ipv4',
    version: 4,
    ihl: 5,
    dscp: o.dscp ?? 0,
    ecn: 0,
    totalLength: 20 + payloadLength(o.payload),
    identification: o.identification & 0xffff,
    flags: o.flags ?? 0,
    fragmentOffset: 0,
    ttl: o.ttl ?? DEFAULT_TTL,
    protocol: o.protocol,
    checksum: 0,
    src: o.src,
    dst: o.dst,
    options: new Uint8Array(0),
    payload: o.payload,
  };
  p.checksum = computeIpv4Checksum(p);
  return p;
}

/** Copy with a new TTL and a recomputed header checksum.
 * (RFC 1624 incremental update would give the same result; we recompute fully for clarity.) */
export function withTtl(p: Ipv4Packet, ttl: number): Ipv4Packet {
  const next = { ...p, ttl };
  next.checksum = computeIpv4Checksum(next);
  return next;
}

export function ipv4HeaderValid(p: Ipv4Packet): boolean {
  return computeIpv4Checksum(p) === p.checksum;
}

export function isFragment(p: Pick<Ipv4Packet, 'flags' | 'fragmentOffset'>): boolean {
  return (p.flags & IPV4_FLAG_MF) !== 0 || p.fragmentOffset > 0;
}

/** Upper-layer bytes carried by this datagram. */
export function payloadBytes(p: Ipv4Packet): Uint8Array {
  if (p.payload.kind === 'raw') return p.payload.bytes;
  const w = new ByteWriter(p.totalLength);
  encodeIcmp(w, p.payload);
  return w.toBytes();
}

/** Largest fragment payload that fits `mtu`: what is left after the header, rounded down to
 * a multiple of 8 (the offset field counts 8-byte units). */
export function maxFragmentData(mtu: number, ihl = 5): number {
  return Math.floor((mtu - ihl * 4) / 8) * 8;
}

/**
 * RFC 791 fragmentation. Each fragment repeats the header (same Identification), carries a
 * slice of the payload, sets MF on all but the last piece and records its position in
 * 8-byte units. Works for already-fragmented datagrams too (offsets are relative to the
 * original, and the last sub-piece keeps the original's MF bit).
 */
export function fragment(p: Ipv4Packet, mtu: number): Ipv4Packet[] {
  if (p.totalLength <= mtu) return [p];
  const hdr = p.ihl * 4;
  const per = maxFragmentData(mtu, p.ihl);
  if (per < 8) throw new Error(`MTU ${mtu} is too small to fragment into`);
  const data = payloadBytes(p);
  const out: Ipv4Packet[] = [];
  for (let off = 0; off < data.length; off += per) {
    const chunk = data.slice(off, off + per);
    const last = off + per >= data.length;
    const mf = !last || (p.flags & IPV4_FLAG_MF) !== 0;
    const frag: Ipv4Packet = {
      ...p,
      totalLength: hdr + chunk.length,
      flags: (p.flags & ~IPV4_FLAG_MF) | (mf ? IPV4_FLAG_MF : 0),
      fragmentOffset: p.fragmentOffset + off / 8,
      payload: { kind: 'raw', bytes: chunk },
      checksum: 0,
    };
    frag.checksum = computeIpv4Checksum(frag);
    out.push(frag);
  }
  return out;
}

/** Decode upper-layer bytes of a reassembled datagram. */
export function decodePayload(protocol: number, bytes: Uint8Array): Ipv4Payload {
  return protocol === IPPROTO_ICMP ? decodeIcmp(new ByteReader(bytes)) : { kind: 'raw', bytes };
}
