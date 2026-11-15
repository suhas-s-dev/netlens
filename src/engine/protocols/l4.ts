/** Transport-layer helpers: the IPv4 pseudo-header checksum (RFC 768, RFC 9293 3.1). */
import { ipToBytes, type Ipv4 } from './addr';
import { internetChecksum } from './checksum';

/** Checksum over pseudo-header (src, dst, zero, protocol, length) + the segment bytes. */
export function l4Checksum(src: Ipv4, dst: Ipv4, protocol: number, segment: Uint8Array): number {
  const buf = new Uint8Array(12 + segment.length);
  buf.set(ipToBytes(src), 0);
  buf.set(ipToBytes(dst), 4);
  buf[9] = protocol;
  buf[10] = (segment.length >>> 8) & 0xff;
  buf[11] = segment.length & 0xff;
  buf.set(segment, 12);
  return internetChecksum(buf);
}

const WELL_KNOWN: Record<number, string> = { 7: 'echo', 22: 'ssh', 53: 'dns', 80: 'http', 179: 'bgp', 443: 'https' };

export function portName(port: number): string {
  const n = WELL_KNOWN[port];
  return n ? `${port} (${n})` : port >= 49152 ? `${port} (ephemeral)` : String(port);
}
