/** Ethernet II framing. Bytes are shown as a capture tool would show them: no preamble/SFD
 * and no FCS, but padded to the 60-byte minimum (64 on the wire with FCS). */
import { bytesToMac, macToBytes } from './addr';
import { decodeArp, encodeArp } from './arp';
import { ByteReader, ByteWriter, hex, type FieldSpan, type LayerSpan } from './bytes';
import { decodeIpv4, encodeIpv4 } from './ipv4';
import { ETHERTYPE_ARP, ETHERTYPE_IPV4, type EthernetFrame, type EthernetPayload } from './types';

export const ETH_HEADER_LEN = 14;
export const ETH_MIN_FRAME = 60; // without FCS
export const ETH_FCS = 4;
export const ETH_PREAMBLE_SFD = 8;
export const ETH_IFG = 12;

const ETHERTYPE_NAMES: Record<number, string> = { [ETHERTYPE_IPV4]: 'IPv4', [ETHERTYPE_ARP]: 'ARP' };

export function etherTypeName(t: number): string {
  return ETHERTYPE_NAMES[t] ?? 'Unknown';
}

export interface EncodedFrame {
  bytes: Uint8Array;
  fields: FieldSpan[];
  layers: LayerSpan[];
}

export function encodeEthernet(f: EthernetFrame): EncodedFrame {
  const w = new ByteWriter(128);
  const L = 'Ethernet II' as const;
  w.layer(L, () => {
    w.field(L, 'eth.dst', 'Destination', f.dst, () => w.bytes(macToBytes(f.dst)));
    w.field(L, 'eth.src', 'Source', f.src, () => w.bytes(macToBytes(f.src)));
    w.field(L, 'eth.type', 'Type', `${etherTypeName(f.etherType)} (${hex(f.etherType, 4)})`, () => w.u16(f.etherType));
  });
  const p = f.payload;
  if (p.kind === 'arp') encodeArp(w, p);
  else if (p.kind === 'ipv4') encodeIpv4(w, p);
  else if (p.bytes.length) w.field('Data', 'data', 'Data', `${p.bytes.length} bytes`, () => w.bytes(p.bytes));
  if (w.length < ETH_MIN_FRAME) {
    const n = ETH_MIN_FRAME - w.length;
    w.field(L, 'eth.padding', 'Padding', `${n} bytes`, () => w.zeros(n));
  }
  return { bytes: w.toBytes(), fields: w.fields, layers: w.layers };
}

export function decodeEthernet(bytes: Uint8Array): EthernetFrame {
  const r = new ByteReader(bytes);
  const dst = bytesToMac(r.bytes(6));
  const src = bytesToMac(r.bytes(6));
  const etherType = r.u16();
  let payload: EthernetPayload;
  if (etherType === ETHERTYPE_ARP) payload = decodeArp(r);
  else if (etherType === ETHERTYPE_IPV4) payload = decodeIpv4(r);
  else payload = { kind: 'raw', bytes: r.rest() };
  // Anything left over is Ethernet padding and is discarded.
  return { dst, src, etherType, payload };
}

/** Bytes the frame occupies on the wire incl. preamble, SFD, FCS and inter-frame gap:
 * this is what serialization delay is computed from. */
export function wireBytes(frameLen: number): number {
  return Math.max(frameLen, ETH_MIN_FRAME) + ETH_FCS + ETH_PREAMBLE_SFD + ETH_IFG;
}
