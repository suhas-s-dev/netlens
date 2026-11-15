/** One-line packet summaries (Wireshark "Info" column style) and protocol classes for colouring. */
import { arpOperName } from './arp';
import { icmpTypeName } from './icmp';
import { isFragment, protoName } from './ipv4';
import {
  ARP_REQUEST,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  IPV4_FLAG_MF,
  isIcmpEcho,
  isIcmpError,
  type EthernetFrame,
} from './types';

export type PacketClass = 'arp' | 'icmp-request' | 'icmp-reply' | 'icmp-error' | 'fragment' | 'ipv4' | 'other';

export function classifyFrame(f: EthernetFrame): PacketClass {
  const p = f.payload;
  if (p.kind === 'arp') return 'arp';
  if (p.kind === 'ipv4') {
    if (isFragment(p)) return 'fragment';
    const q = p.payload;
    if (q.kind === 'icmp') {
      if (q.type === ICMP_ECHO_REQUEST) return 'icmp-request';
      if (q.type === ICMP_ECHO_REPLY) return 'icmp-reply';
      return 'icmp-error';
    }
    return 'ipv4';
  }
  return 'other';
}

export function summarizeFrame(f: EthernetFrame): string {
  const p = f.payload;
  if (p.kind === 'arp') {
    return p.oper === ARP_REQUEST ? `ARP Who has ${p.tpa}? Tell ${p.spa}` : `ARP ${p.spa} is at ${p.sha}`;
  }
  if (p.kind === 'ipv4') {
    if (isFragment(p)) {
      const from = p.fragmentOffset * 8;
      return `IPv4 fragment ${p.src} → ${p.dst} id=${p.identification} offset=${p.fragmentOffset} (bytes ${from}–${from + p.totalLength - p.ihl * 4 - 1})${p.flags & IPV4_FLAG_MF ? ' MF' : ''}`;
    }
    const q = p.payload;
    if (q.kind === 'icmp') {
      if (isIcmpEcho(q)) {
        return `ICMP ${q.type === ICMP_ECHO_REQUEST ? 'echo request' : 'echo reply'} ${p.src} → ${p.dst} id=${q.identifier} seq=${q.sequence} ttl=${p.ttl}`;
      }
      if (isIcmpError(q)) return `ICMP ${icmpTypeName(q.type, q.code)} ${p.src} → ${p.dst}`;
      return `ICMP type ${q.type} ${p.src} → ${p.dst}`;
    }
    return `IPv4 ${protoName(p.protocol)} ${p.src} → ${p.dst}`;
  }
  return `Ethernet ${f.src} → ${f.dst}`;
}

export { arpOperName };
