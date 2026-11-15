import { encodeEthernet, wireBytes, type EncodedFrame } from '../protocols/ethernet';
import type { EthernetFrame } from '../protocols/types';

/**
 * One frame transmission on one link. Every copy put on a wire gets a fresh `id`, so the
 * renderer can track it; `flowId` stays the same as an IP datagram (or ARP exchange) moves
 * hop by hop, and `parentId` points at the frame it was forwarded/flooded from.
 */
export interface Frame {
  id: string;
  flowId: string;
  parentId?: string;
  eth: EthernetFrame;
}

const encCache = new WeakMap<EthernetFrame, EncodedFrame>();

/** Encoded bytes + field spans; cached per (immutable) header object. */
export function encodeFrame(eth: EthernetFrame): EncodedFrame {
  let e = encCache.get(eth);
  if (!e) {
    e = encodeEthernet(eth);
    encCache.set(eth, e);
  }
  return e;
}

export function frameWireBytes(eth: EthernetFrame): number {
  return wireBytes(encodeFrame(eth).bytes.length);
}
