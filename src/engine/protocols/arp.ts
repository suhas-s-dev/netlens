/** ARP (RFC 826) for Ethernet/IPv4. */
import { bytesToIp, bytesToMac, ipToBytes, macToBytes, ZERO_MAC, type Ipv4, type Mac } from './addr';
import { ByteReader, ByteWriter, hex } from './bytes';
import { ARP_REPLY, ARP_REQUEST, ETHERTYPE_IPV4, type ArpPacket } from './types';

export const ARP_LENGTH = 28;

export function makeArpRequest(sha: Mac, spa: Ipv4, tpa: Ipv4): ArpPacket {
  // RFC 826: target hardware address is "don't care" in a request; conventionally zero.
  return { kind: 'arp', htype: 1, ptype: ETHERTYPE_IPV4, hlen: 6, plen: 4, oper: ARP_REQUEST, sha, spa, tha: ZERO_MAC, tpa };
}

export function makeArpReply(sha: Mac, spa: Ipv4, tha: Mac, tpa: Ipv4): ArpPacket {
  return { kind: 'arp', htype: 1, ptype: ETHERTYPE_IPV4, hlen: 6, plen: 4, oper: ARP_REPLY, sha, spa, tha, tpa };
}

export function arpOperName(oper: number): string {
  return oper === ARP_REQUEST ? 'request' : oper === ARP_REPLY ? 'reply' : `op ${oper}`;
}

export function encodeArp(w: ByteWriter, p: ArpPacket): void {
  const L = 'ARP' as const;
  w.layer(L, () => {
    w.field(L, 'arp.htype', 'Hardware type', `${p.htype === 1 ? 'Ethernet' : 'Unknown'} (${p.htype})`, () => w.u16(p.htype));
    w.field(L, 'arp.ptype', 'Protocol type', `${p.ptype === ETHERTYPE_IPV4 ? 'IPv4' : 'Unknown'} (${hex(p.ptype, 4)})`, () => w.u16(p.ptype));
    w.field(L, 'arp.hlen', 'Hardware size', String(p.hlen), () => w.u8(p.hlen));
    w.field(L, 'arp.plen', 'Protocol size', String(p.plen), () => w.u8(p.plen));
    w.field(L, 'arp.oper', 'Opcode', `${arpOperName(p.oper)} (${p.oper})`, () => w.u16(p.oper));
    w.field(L, 'arp.sha', 'Sender MAC address', p.sha, () => w.bytes(macToBytes(p.sha)));
    w.field(L, 'arp.spa', 'Sender IP address', p.spa, () => w.bytes(ipToBytes(p.spa)));
    w.field(L, 'arp.tha', 'Target MAC address', p.tha, () => w.bytes(macToBytes(p.tha)));
    w.field(L, 'arp.tpa', 'Target IP address', p.tpa, () => w.bytes(ipToBytes(p.tpa)));
  });
}

export function decodeArp(r: ByteReader): ArpPacket {
  const htype = r.u16();
  const ptype = r.u16();
  const hlen = r.u8();
  const plen = r.u8();
  if (hlen !== 6 || plen !== 4) throw new Error(`Unsupported ARP sizes hlen=${hlen} plen=${plen}`);
  const oper = r.u16();
  const sha = bytesToMac(r.bytes(6));
  const spa = bytesToIp(r.bytes(4));
  const tha = bytesToMac(r.bytes(6));
  const tpa = bytesToIp(r.bytes(4));
  return { kind: 'arp', htype, ptype, hlen, plen, oper, sha, spa, tha, tpa };
}
