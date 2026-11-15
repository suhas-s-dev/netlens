/** ICMP (RFC 792). */
import { bytesToIp } from './addr';
import { ByteReader, ByteWriter, hex } from './bytes';
import { internetChecksum } from './checksum';
import {
  ICMP_DEST_UNREACHABLE,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_TIME_EXCEEDED,
  isIcmpEcho,
  isIcmpError,
  type IcmpEcho,
  type IcmpError,
  type IcmpMessage,
} from './types';

/** Default echo payload, same 32-byte pattern Windows ping uses. */
export const DEFAULT_PING_DATA = Uint8Array.from('abcdefghijklmnopqrstuvwabcdefghi', (c) => c.charCodeAt(0));

const UNREACH_CODES: Record<number, string> = {
  0: 'Network unreachable',
  1: 'Host unreachable',
  2: 'Protocol unreachable',
  3: 'Port unreachable',
  4: 'Fragmentation needed',
  13: 'Communication administratively prohibited',
};

export function icmpTypeName(type: number, code: number): string {
  switch (type) {
    case ICMP_ECHO_REPLY:
      return 'Echo (ping) reply';
    case ICMP_ECHO_REQUEST:
      return 'Echo (ping) request';
    case ICMP_DEST_UNREACHABLE:
      return `Destination unreachable (${UNREACH_CODES[code] ?? `code ${code}`})`;
    case ICMP_TIME_EXCEEDED:
      return code === 0 ? 'Time-to-live exceeded in transit' : 'Fragment reassembly time exceeded';
    default:
      return `Type ${type}`;
  }
}

/** Length of the encoded ICMP message. */
export function icmpLength(m: IcmpMessage): number {
  if (isIcmpEcho(m)) return 8 + m.data.length;
  if (isIcmpError(m)) return 8 + m.original.length;
  return 4 + m.rest.length;
}

function writeBody(w: ByteWriter, m: IcmpMessage, withSpans: boolean): void {
  const L = 'ICMP' as const;
  const f = (key: string, label: string, display: string, fn: () => void) =>
    withSpans ? w.field(L, key, label, display, fn) : fn();
  f('icmp.type', 'Type', `${m.type} (${icmpTypeName(m.type, m.code)})`, () => w.u8(m.type));
  f('icmp.code', 'Code', String(m.code), () => w.u8(m.code));
  f('icmp.checksum', 'Checksum', hex(m.checksum, 4), () => w.u16(m.checksum));
  if (isIcmpEcho(m)) {
    f('icmp.identifier', 'Identifier', `${m.identifier} (${hex(m.identifier, 4)})`, () => w.u16(m.identifier));
    f('icmp.sequence', 'Sequence number', String(m.sequence), () => w.u16(m.sequence));
    if (m.data.length) f('icmp.data', 'Data', `${m.data.length} bytes`, () => w.bytes(m.data));
  } else if (isIcmpError(m)) {
    f('icmp.unused', 'Unused', hex(m.unused, 8), () => w.u32(m.unused));
    if (m.original.length) {
      f('icmp.original', 'Original datagram', describeOriginal(m.original), () => w.bytes(m.original));
    }
  } else if (m.rest.length) {
    f('icmp.rest', 'Rest of message', `${m.rest.length} bytes`, () => w.bytes(m.rest));
  }
}

function describeOriginal(orig: Uint8Array): string {
  if (orig.length < 20) return `${orig.length} bytes`;
  return `IPv4 ${bytesToIp(orig, 12)} → ${bytesToIp(orig, 16)}, proto ${orig[9]}, ttl ${orig[8]} (+${orig.length - 20} payload bytes)`;
}

export function computeIcmpChecksum(m: IcmpMessage): number {
  const w = new ByteWriter(icmpLength(m));
  writeBody(w, { ...m, checksum: 0 }, false);
  return internetChecksum(w.toBytes());
}

export function encodeIcmp(w: ByteWriter, m: IcmpMessage): void {
  w.layer('ICMP', () => writeBody(w, m, true));
}

export function decodeIcmp(r: ByteReader): IcmpMessage {
  const type = r.u8();
  const code = r.u8();
  const checksum = r.u16();
  if (type === ICMP_ECHO_REQUEST || type === ICMP_ECHO_REPLY) {
    const identifier = r.u16();
    const sequence = r.u16();
    const data = r.rest();
    return { kind: 'icmp', type, code, checksum, identifier, sequence, data };
  }
  if (type === ICMP_DEST_UNREACHABLE || type === ICMP_TIME_EXCEEDED) {
    const unused = r.u32();
    const original = r.rest();
    return { kind: 'icmp', type, code, checksum, unused, original };
  }
  return { kind: 'icmp', type, code, checksum, rest: r.rest(), other: true };
}

export function makeEcho(
  type: typeof ICMP_ECHO_REQUEST | typeof ICMP_ECHO_REPLY,
  identifier: number,
  sequence: number,
  data: Uint8Array = DEFAULT_PING_DATA,
): IcmpEcho {
  const m: IcmpEcho = { kind: 'icmp', type, code: 0, checksum: 0, identifier, sequence, data };
  m.checksum = computeIcmpChecksum(m);
  return m;
}

/**
 * Build an ICMP error quoting the offending datagram.
 * RFC 792: include the internet header plus the first 64 bits of the original data.
 * (RFC 1812 4.3.2.3 allows routers to quote more; we keep the RFC 792 minimum.)
 */
export function makeIcmpError(
  type: typeof ICMP_DEST_UNREACHABLE | typeof ICMP_TIME_EXCEEDED,
  code: number,
  originalDatagram: Uint8Array,
): IcmpError {
  const ihlBytes = ((originalDatagram[0] ?? 0x45) & 0x0f) * 4;
  const original = originalDatagram.slice(0, Math.min(originalDatagram.length, ihlBytes + 8));
  const m: IcmpError = { kind: 'icmp', type, code, checksum: 0, unused: 0, original };
  m.checksum = computeIcmpChecksum(m);
  return m;
}
