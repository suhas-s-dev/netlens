/** UDP (RFC 768). */
import type { Ipv4 } from './addr';
import { ByteReader, ByteWriter, hex } from './bytes';
import { l4Checksum, portName } from './l4';
import { IPPROTO_UDP, type UdpDatagram } from './types';

function write(w: ByteWriter, u: UdpDatagram, spans: boolean): void {
  const L = 'UDP' as const;
  const f = (key: string, label: string, display: string, fn: () => void) => (spans ? w.field(L, key, label, display, fn) : fn());
  f('udp.sport', 'Source port', portName(u.srcPort), () => w.u16(u.srcPort));
  f('udp.dport', 'Destination port', portName(u.dstPort), () => w.u16(u.dstPort));
  f('udp.len', 'Length', `${u.length} (8 header + ${u.data.length} data)`, () => w.u16(u.length));
  f('udp.checksum', 'Checksum', hex(u.checksum, 4), () => w.u16(u.checksum));
  if (u.data.length) f('udp.data', 'Data', `${u.data.length} bytes`, () => w.bytes(u.data));
}

export function encodeUdp(w: ByteWriter, u: UdpDatagram): void {
  w.layer('UDP', () => write(w, u, true));
}

export function udpBytes(u: UdpDatagram): Uint8Array {
  const w = new ByteWriter(8 + u.data.length);
  write(w, u, false);
  return w.toBytes();
}

export function decodeUdp(r: ByteReader): UdpDatagram {
  const srcPort = r.u16();
  const dstPort = r.u16();
  const length = r.u16();
  const checksum = r.u16();
  const data = r.bytes(Math.max(0, Math.min(length - 8, r.remaining)));
  return { kind: 'udp', srcPort, dstPort, length, checksum, data };
}

export function makeUdp(src: Ipv4, dst: Ipv4, srcPort: number, dstPort: number, data: Uint8Array): UdpDatagram {
  const u: UdpDatagram = { kind: 'udp', srcPort, dstPort, length: 8 + data.length, checksum: 0, data };
  const c = l4Checksum(src, dst, IPPROTO_UDP, udpBytes(u));
  // RFC 768: a computed checksum of zero is sent as all ones (zero means "no checksum").
  u.checksum = c === 0 ? 0xffff : c;
  return u;
}

export function udpChecksumValid(src: Ipv4, dst: Ipv4, u: UdpDatagram): boolean {
  return u.checksum === 0 || l4Checksum(src, dst, IPPROTO_UDP, udpBytes(u)) === 0;
}
