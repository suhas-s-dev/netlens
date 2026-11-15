/** IP output with MTU handling, shared by hosts and routers. */
import { SEC } from '../core/time';
import type { ScheduledEvent } from '../core/EventQueue';
import type { Frame } from '../model/frame';
import type { Ipv4 } from '../protocols/addr';
import { computeIpv4Checksum, decodePayload, fragment, payloadBytes } from '../protocols/ipv4';
import { IPV4_FLAG_DF, IPV4_FLAG_MF, type Ipv4Packet } from '../protocols/types';
import type { ArpResolver } from './ArpResolver';
import type { Device, Port, SendMeta } from './Device';

/**
 * Send `pkt` out of `port` towards `nextHop`, fragmenting it to fit `mtu` (RFC 791).
 * Returns 'too-big' instead when it doesn't fit and DF is set: the caller reports that
 * (router: ICMP Fragmentation Needed; host: "message too long").
 */
export function ipOutput(dev: Device, arp: ArpResolver, port: Port, nextHop: Ipv4, pkt: Ipv4Packet, meta: SendMeta, mtu = port.mtu): 'ok' | 'too-big' {
  if (pkt.totalLength <= mtu) {
    arp.sendIpv4(port, nextHop, pkt, meta);
    return 'ok';
  }
  if (pkt.flags & IPV4_FLAG_DF) return 'too-big';
  const frags = fragment(pkt, mtu);
  dev.decision(
    'fragment',
    `${dev.name} ${pkt.totalLength}-byte packet won't fit ${port.id}'s MTU ${mtu}: split into ${frags.length} fragments (offsets ${frags
      .map((f) => f.fragmentOffset)
      .join(', ')}, sizes ${frags.map((f) => f.totalLength).join(', ')} bytes)`,
    { ifaces: [port.id], flowId: meta.flowId },
  );
  for (const f of frags) arp.sendIpv4(port, nextHop, f, meta);
  return 'ok';
}

interface Buffer {
  parts: Map<number, Uint8Array>;
  total?: number;
  first?: Ipv4Packet;
  timer: ScheduledEvent;
  count: number;
}

/**
 * RFC 791 reassembly at the final destination. Fragments are keyed by
 * (source, destination, protocol, identification); the datagram is rebuilt once the last
 * fragment (MF = 0) and every byte before it have arrived. Incomplete datagrams are
 * dropped after `timeoutNs` (30 s, as Linux), with ICMP Time Exceeded code 1 to the sender
 * if the first fragment arrived (RFC 1122 3.3.2).
 */
export class Reassembler {
  private bufs = new Map<string, Buffer>();

  constructor(
    private dev: Device,
    private onTimeout: (first: Ipv4Packet | undefined, fragments: number) => void,
    readonly timeoutNs = 30 * SEC,
  ) {}

  add(p: Ipv4Packet, frame: Frame): Ipv4Packet | null {
    const key = `${p.src}|${p.dst}|${p.protocol}|${p.identification}`;
    const dev = this.dev;
    let b = this.bufs.get(key);
    if (!b) {
      const timer = dev.engine.schedule(
        this.timeoutNs,
        `${dev.name} reassembly timeout ${key}`,
        () => {
          const cur = this.bufs.get(key);
          if (!cur) return;
          this.bufs.delete(key);
          dev.drop('reassembly-timeout', `${dev.name} gave up reassembling packet id=${p.identification} from ${p.src}: fragments missing after ${this.timeoutNs / SEC} s`, { flowId: frame.flowId });
          this.onTimeout(cur.first, cur.count);
        },
        dev.id,
      );
      b = { parts: new Map(), timer, count: 0 };
      this.bufs.set(key, b);
    }
    const off = p.fragmentOffset * 8;
    const data = payloadBytes(p);
    b.parts.set(off, data);
    b.count++;
    if (!(p.flags & IPV4_FLAG_MF)) b.total = off + data.length;
    if (off === 0) b.first = p;

    // Contiguous bytes received from offset 0.
    let have = 0;
    for (const [o, d] of [...b.parts.entries()].sort((x, y) => x[0] - y[0])) {
      if (o > have) break;
      have = Math.max(have, o + d.length);
    }
    const meta = { packetId: frame.id, flowId: frame.flowId };
    if (b.total === undefined || !b.first || have < b.total) {
      dev.decision(
        'reassemble',
        `${dev.name} holding fragment (bytes ${off}–${off + data.length - 1}) of packet id=${p.identification} from ${p.src}; waiting for the rest${b.total ? ` (${have}/${b.total} bytes so far)` : ''}`,
        meta,
      );
      return null;
    }
    b.timer.cancelled = true;
    this.bufs.delete(key);
    const all = new Uint8Array(b.total);
    for (const [o, d] of b.parts) all.set(d.subarray(0, Math.max(0, Math.min(d.length, b.total - o))), o);
    const whole: Ipv4Packet = {
      ...b.first,
      flags: b.first.flags & ~IPV4_FLAG_MF,
      fragmentOffset: 0,
      totalLength: b.first.ihl * 4 + b.total,
      payload: decodePayload(b.first.protocol, all),
      checksum: 0,
    };
    whole.checksum = computeIpv4Checksum(whole);
    dev.decision('reassemble', `${dev.name} reassembled ${b.count} fragments into the original ${whole.totalLength}-byte packet (id=${p.identification})`, meta);
    return whole;
  }
}
