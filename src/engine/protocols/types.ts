/** Layered header models. Plain, immutable-by-convention objects so they can be
 * structured-cloned (Web Worker / Durable Object later) and inspected by the UI. */
import type { Ipv4, Mac } from './addr';

export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_ARP = 0x0806;

export const IPPROTO_ICMP = 1;
// Phase 2: IPPROTO_TCP = 6, IPPROTO_UDP = 17

export interface RawPayload {
  kind: 'raw';
  bytes: Uint8Array;
}

export interface EthernetFrame {
  dst: Mac;
  src: Mac;
  etherType: number;
  payload: EthernetPayload;
}

export type EthernetPayload = ArpPacket | Ipv4Packet | RawPayload;

export const ARP_REQUEST = 1;
export const ARP_REPLY = 2;

export interface ArpPacket {
  kind: 'arp';
  htype: number; // 1 = Ethernet
  ptype: number; // 0x0800 = IPv4
  hlen: number; // 6
  plen: number; // 4
  oper: number; // 1 request, 2 reply
  sha: Mac;
  spa: Ipv4;
  tha: Mac;
  tpa: Ipv4;
}

export const IPV4_FLAG_DF = 0b010;
export const IPV4_FLAG_MF = 0b001;

export interface Ipv4Packet {
  kind: 'ipv4';
  version: number;
  ihl: number; // header length in 32-bit words
  dscp: number;
  ecn: number;
  totalLength: number;
  identification: number;
  flags: number; // 3 bits: reserved, DF, MF
  fragmentOffset: number;
  ttl: number;
  protocol: number;
  checksum: number;
  src: Ipv4;
  dst: Ipv4;
  options: Uint8Array;
  payload: Ipv4Payload;
}

export type Ipv4Payload = IcmpMessage | RawPayload;

export const ICMP_ECHO_REPLY = 0;
export const ICMP_DEST_UNREACHABLE = 3;
export const ICMP_ECHO_REQUEST = 8;
export const ICMP_TIME_EXCEEDED = 11;

export const ICMP_UNREACH_NET = 0;
export const ICMP_UNREACH_HOST = 1;
export const ICMP_UNREACH_PROTOCOL = 2;
export const ICMP_UNREACH_PORT = 3;
export const ICMP_TIMX_INTRANS = 0; // TTL exceeded in transit

export interface IcmpEcho {
  kind: 'icmp';
  type: typeof ICMP_ECHO_REPLY | typeof ICMP_ECHO_REQUEST;
  code: number;
  checksum: number;
  identifier: number;
  sequence: number;
  data: Uint8Array;
}

export interface IcmpError {
  kind: 'icmp';
  type: typeof ICMP_DEST_UNREACHABLE | typeof ICMP_TIME_EXCEEDED;
  code: number;
  checksum: number;
  /** 32-bit "unused" word (must be zero for these types in RFC 792). */
  unused: number;
  /** Original IP header + first 8 bytes of its payload (RFC 792). */
  original: Uint8Array;
}

/** ICMP types the MVP does not model: kept as type/code/checksum + raw rest-of-message. */
export interface IcmpOther {
  kind: 'icmp';
  type: number;
  code: number;
  checksum: number;
  rest: Uint8Array;
  other: true;
}

export type IcmpMessage = IcmpEcho | IcmpError | IcmpOther;

export function isIcmpEcho(m: IcmpMessage): m is IcmpEcho {
  return !('other' in m) && (m.type === ICMP_ECHO_REQUEST || m.type === ICMP_ECHO_REPLY);
}

export function isIcmpError(m: IcmpMessage): m is IcmpError {
  return !('other' in m) && (m.type === ICMP_DEST_UNREACHABLE || m.type === ICMP_TIME_EXCEEDED);
}
