import { describe, expect, it } from 'vitest';
import { broadcastOf, inSubnet, intToIp, ipToInt, networkOf, prefixToMask, subnetsOverlap } from '../protocols/addr';
import { makeArpReply, makeArpRequest } from '../protocols/arp';
import { fromHexString, toHexString } from '../protocols/bytes';
import { checksumValid, internetChecksum } from '../protocols/checksum';
import { decodeEthernet, encodeEthernet, wireBytes } from '../protocols/ethernet';
import { computeIcmpChecksum, DEFAULT_PING_DATA, makeEcho, makeIcmpError } from '../protocols/icmp';
import { computeIpv4Checksum, encodeIpv4Datagram, ipv4HeaderValid, makeIpv4, withTtl } from '../protocols/ipv4';
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ICMP_DEST_UNREACHABLE,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_TIME_EXCEEDED,
  IPPROTO_ICMP,
  type EthernetFrame,
} from '../protocols/types';

describe('internet checksum (RFC 1071)', () => {
  it('matches the RFC 1071 section 3 worked example', () => {
    // RFC 1071: bytes 00 01 f2 03 f4 f5 f6 f7 sum to 0xddf2; checksum is its complement.
    expect(internetChecksum(fromHexString('0001f203f4f5f6f7'))).toBe(0x220d);
  });

  it('matches the classic IPv4 header example (checksum 0xb861)', () => {
    const hdr = fromHexString('45000073 00004000 40110000 c0a80001 c0a800c7');
    expect(internetChecksum(hdr)).toBe(0xb861);
    hdr[10] = 0xb8;
    hdr[11] = 0x61;
    expect(checksumValid(hdr)).toBe(true);
  });

  it('pads an odd trailing byte with zero', () => {
    expect(internetChecksum(Uint8Array.of(0x01))).toBe(~0x0100 & 0xffff);
  });
});

describe('ICMP checksum', () => {
  it('matches the well-known Windows ping (id=1 seq=1, 32-byte alphabet payload) value 0x4d5a', () => {
    const m = makeEcho(ICMP_ECHO_REQUEST, 1, 1, DEFAULT_PING_DATA);
    expect(m.checksum).toBe(0x4d5a);
    expect(computeIcmpChecksum(m)).toBe(0x4d5a);
  });
});

describe('IPv4 header', () => {
  it('computes a checksum that validates and changes when TTL is decremented', () => {
    const p = makeIpv4({ src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_ICMP, identification: 0x1c46, ttl: 128, payload: makeEcho(8, 1, 1) });
    expect(p.checksum).toBe(0x0a79); // independently computed reference
    expect(ipv4HeaderValid(p)).toBe(true);
    const q = withTtl(p, 127);
    expect(q.ttl).toBe(127);
    expect(q.checksum).not.toBe(p.checksum);
    expect(ipv4HeaderValid(q)).toBe(true);
    expect(computeIpv4Checksum(q)).toBe(q.checksum);
    expect(p.ttl).toBe(128); // original untouched
  });
});

const MAC_A = '02:00:00:00:00:01';
const MAC_B = '02:00:00:00:00:02';

function roundTrip(f: EthernetFrame): EthernetFrame {
  const enc = encodeEthernet(f);
  const dec = decodeEthernet(enc.bytes);
  expect(encodeEthernet(dec).bytes).toEqual(enc.bytes);
  return dec;
}

describe('encode/decode round-trips', () => {
  it('Ethernet + IPv4 + ICMP echo request produces the exact reference bytes', () => {
    const ip = makeIpv4({ src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_ICMP, identification: 0x1c46, ttl: 128, payload: makeEcho(ICMP_ECHO_REQUEST, 1, 1) });
    const f: EthernetFrame = { dst: MAC_B, src: MAC_A, etherType: ETHERTYPE_IPV4, payload: ip };
    const enc = encodeEthernet(f);
    expect(toHexString(enc.bytes).replace(/ /g, '')).toBe(
      '02000000000202000000000108004500003c1c46000080010a790a0000010a00000208004d5a000100016162636465666768696a6b6c6d6e6f7071727374757677616263646566676869',
    );
    expect(roundTrip(f)).toEqual(f);
  });

  it('ICMP echo reply', () => {
    const ip = makeIpv4({ src: '10.0.0.2', dst: '10.0.0.1', protocol: IPPROTO_ICMP, identification: 7, payload: makeEcho(ICMP_ECHO_REPLY, 0x1234, 9) });
    expect(roundTrip({ dst: MAC_A, src: MAC_B, etherType: ETHERTYPE_IPV4, payload: ip })).toMatchObject({ payload: { payload: { type: 0, identifier: 0x1234, sequence: 9 } } });
  });

  it('ARP request and reply, padded to 60 bytes', () => {
    const req: EthernetFrame = { dst: 'ff:ff:ff:ff:ff:ff', src: MAC_A, etherType: ETHERTYPE_ARP, payload: makeArpRequest(MAC_A, '10.0.0.1', '10.0.0.2') };
    const enc = encodeEthernet(req);
    expect(enc.bytes.length).toBe(60);
    expect(enc.fields.find((s) => s.key === 'eth.padding')).toMatchObject({ start: 42, end: 60 });
    expect(roundTrip(req)).toEqual(req);
    const rep: EthernetFrame = { dst: MAC_A, src: MAC_B, etherType: ETHERTYPE_ARP, payload: makeArpReply(MAC_B, '10.0.0.2', MAC_A, '10.0.0.1') };
    expect(roundTrip(rep)).toEqual(rep);
  });

  it('ICMP Time Exceeded and Destination Unreachable quote the original header + 8 bytes', () => {
    const orig = makeIpv4({ src: '10.0.1.10', dst: '10.0.3.10', protocol: IPPROTO_ICMP, identification: 42, ttl: 1, payload: makeEcho(8, 5, 1) });
    const quoted = encodeIpv4Datagram(orig);
    for (const [type, code] of [
      [ICMP_TIME_EXCEEDED, 0],
      [ICMP_DEST_UNREACHABLE, 0],
    ] as const) {
      const err = makeIcmpError(type, code, quoted);
      expect(err.original.length).toBe(28);
      expect(err.original).toEqual(quoted.slice(0, 28));
      const ip = makeIpv4({ src: '10.0.12.1', dst: '10.0.1.10', protocol: IPPROTO_ICMP, identification: 1, payload: err });
      const f: EthernetFrame = { dst: MAC_A, src: MAC_B, etherType: ETHERTYPE_IPV4, payload: ip };
      const dec = roundTrip(f);
      expect(dec).toEqual(f);
      const bytes = encodeEthernet(f).bytes;
      expect(checksumValid(bytes, 14, 34)).toBe(true); // IPv4 header
      expect(checksumValid(bytes, 34, 14 + ip.totalLength)).toBe(true); // ICMP message
    }
  });

  it('raw payloads survive', () => {
    const f: EthernetFrame = { dst: MAC_B, src: MAC_A, etherType: 0x88b5, payload: { kind: 'raw', bytes: new Uint8Array(64).fill(7) } };
    expect(roundTrip(f)).toEqual(f);
  });

  it('field spans tile the frame with no gaps or overlaps (excluding bit fields)', () => {
    const ip = makeIpv4({ src: '10.0.0.1', dst: '10.0.0.2', protocol: IPPROTO_ICMP, identification: 1, payload: makeEcho(8, 1, 1) });
    const enc = encodeEthernet({ dst: MAC_B, src: MAC_A, etherType: ETHERTYPE_IPV4, payload: ip });
    const covered = new Array<number>(enc.bytes.length).fill(0);
    for (const s of enc.fields.filter((s) => !s.bits)) for (let i = s.start; i < s.end; i++) covered[i]!++;
    // bytes 14,15 (ver/ihl, dscp/ecn) and 20,21 (flags/frag) are covered only by bit fields
    for (const i of [14, 15, 20, 21]) expect(enc.fields.some((s) => s.bits && s.start <= i && i < s.end)).toBe(true);
    covered.forEach((c, i) => {
      if (![14, 15, 20, 21].includes(i)) expect(c, `byte ${i}`).toBe(1);
    });
    expect(enc.layers.map((l) => l.layer)).toEqual(['Ethernet II', 'IPv4', 'ICMP']);
  });

  it('wire size includes preamble, FCS and IFG', () => {
    expect(wireBytes(42)).toBe(60 + 4 + 8 + 12);
    expect(wireBytes(1514)).toBe(1514 + 24);
  });
});

describe('addressing', () => {
  it('converts and masks', () => {
    expect(intToIp(ipToInt('192.168.1.200'))).toBe('192.168.1.200');
    expect(prefixToMask(24)).toBe(0xffffff00);
    expect(prefixToMask(0)).toBe(0);
    expect(networkOf('10.1.2.3', 16)).toBe('10.1.0.0');
    expect(broadcastOf('10.1.2.3', 24)).toBe('10.1.2.255');
    expect(inSubnet('10.0.2.15', '10.0.2.0', 24)).toBe(true);
    expect(inSubnet('10.0.3.15', '10.0.2.0', 24)).toBe(false);
    expect(subnetsOverlap('10.0.0.0', 8, '10.5.0.0', 16)).toBe(true);
    expect(subnetsOverlap('10.0.0.0', 24, '10.0.1.0', 24)).toBe(false);
  });
});
