/**
 * IPv4 router (RFC 1812 subset): connected + static routes, longest-prefix match,
 * TTL decrement with header checksum recompute, ICMP Time Exceeded / Destination
 * Unreachable, per-interface ARP (no proxy ARP), answers pings to its own addresses.
 */
import type { Engine } from '../core/Engine';
import { SEC } from '../core/time';
import type { Frame } from '../model/frame';
import { broadcastOf, isGroupMac, LIMITED_BROADCAST, type Ipv4 } from '../protocols/addr';
import { icmpTypeName, makeEcho, makeIcmpError } from '../protocols/icmp';
import { encodeIpv4Datagram, ipv4HeaderValid, makeIpv4, withTtl } from '../protocols/ipv4';
import { hex } from '../protocols/bytes';
import {
  ICMP_DEST_UNREACHABLE,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_TIME_EXCEEDED,
  ICMP_TIMX_INTRANS,
  ICMP_UNREACH_HOST,
  ICMP_UNREACH_NEEDFRAG,
  ICMP_UNREACH_NET,
  ICMP_UNREACH_PORT,
  IPPROTO_TCP,
  TCP_ACK,
  TCP_FIN,
  TCP_RST,
  TCP_SYN,
  ICMP_TIMX_REASS,
  IPPROTO_ICMP,
  isIcmpEcho,
  isIcmpError,
  type Ipv4Packet,
} from '../protocols/types';
import { ArpResolver, type ArpConfig, type QueuedPacket } from './ArpResolver';
import { Device, type Port, type PortInit, type SendMeta } from './Device';
import { ipOutput, Reassembler } from './ipOutput';
import { isFragment } from '../protocols/ipv4';
import { makeTcp } from '../protocols/tcp';
import { buildRoutingTable, cidr, longestPrefixMatch, type Route, type StaticRouteSpec } from './routing';
import type { RouterState } from './state';
import { portViews } from './Switch';

export const DEFAULT_ARP_CONFIG: ArpConfig = { timeoutNs: 60 * SEC, retryNs: 1 * SEC, maxAttempts: 3, maxQueue: 10 };

export class Router extends Device {
  readonly kind = 'router' as const;
  readonly routes: Route[];
  readonly arp: ArpResolver;
  private ipId: number;
  private reasm: Reassembler;

  constructor(engine: Engine, id: string, name: string, ports: PortInit[], statics: StaticRouteSpec[], arpConfig: ArpConfig = DEFAULT_ARP_CONFIG) {
    super(engine, id, name, ports);
    this.routes = buildRoutingTable(
      [...this.ports.values()].filter((p) => p.ip).map((p) => ({ id: p.id, addr: p.ip!.addr, prefix: p.ip!.prefix })),
      statics,
    );
    this.arp = new ArpResolver(this, arpConfig, (port, ip, dropped) => this.onArpFailed(port, ip, dropped));
    this.ipId = engine.rng.int(0, 0xffff);
    this.reasm = new Reassembler(this, (first) => {
      if (first) this.sendIcmpError(first, ICMP_TIME_EXCEEDED, ICMP_TIMX_REASS);
    });
  }

  receive(port: Port, frame: Frame): void {
    const eth = frame.eth;
    if (eth.dst !== port.mac && !isGroupMac(eth.dst)) {
      this.drop('not-for-me', `${this.name} ${port.id} discarded frame for ${eth.dst} (not its MAC)`, { iface: port.id, packetId: frame.id, flowId: frame.flowId });
      return;
    }
    const p = eth.payload;
    if (p.kind === 'arp') this.arp.handle(port, p, frame);
    else if (p.kind === 'ipv4') this.handleIpv4(port, p, frame);
    else this.drop('unsupported', `${this.name} ignored frame with EtherType ${hex(eth.etherType, 4)}`, { iface: port.id, packetId: frame.id });
  }

  private isDirectedBroadcast(dst: Ipv4): boolean {
    for (const p of this.ports.values()) if (p.ip && p.ip.prefix < 31 && broadcastOf(p.ip.addr, p.ip.prefix) === dst) return true;
    return false;
  }

  private handleIpv4(port: Port, ip: Ipv4Packet, frame: Frame): void {
    const meta = { packetId: frame.id, flowId: frame.flowId };
    if (!ipv4HeaderValid(ip)) {
      this.drop('bad-checksum', `${this.name} dropped packet from ${ip.src}: bad IPv4 header checksum`, { iface: port.id, ...meta });
      return;
    }
    if (this.portByIp(ip.dst)) {
      this.deliverLocal(port, ip, frame);
      return;
    }
    if (ip.dst === LIMITED_BROADCAST || this.isDirectedBroadcast(ip.dst)) {
      // RFC 1812 5.3.5: limited broadcasts are never forwarded; directed-broadcast
      // forwarding defaults to off (RFC 2644).
      this.drop('broadcast-not-forwarded', `${this.name} does not forward broadcast to ${ip.dst}`, { iface: port.id, ...meta });
      return;
    }

    const { best, matches } = longestPrefixMatch(this.routes, ip.dst);
    if (!best) {
      this.drop('no-route', `${this.name} has no route to ${ip.dst}`, { iface: port.id, ...meta });
      this.sendIcmpError(ip, ICMP_DEST_UNREACHABLE, ICMP_UNREACH_NET, frame);
      return;
    }
    const others = matches.slice(1).map(cidr);
    this.decision(
      'lpm',
      `${this.name} LPM: ${ip.dst} matched ${cidr(best)} via ${best.iface} (${best.type === 'connected' ? 'connected' : `static, next hop ${best.nextHop}`})` +
        (others.length ? `; also matched ${others.join(', ')}` : ''),
      { ifaces: [best.iface], ...meta },
    );

    // RFC 1812 5.3.1: a packet that would leave with TTL 0 is discarded with Time Exceeded.
    // (Route lookup happens first, like Linux, so an unroutable packet gets Unreachable.)
    if (ip.ttl <= 1) {
      this.drop('ttl-expired', `${this.name} dropped packet: TTL expired, sending ICMP Time Exceeded to ${ip.src}`, { iface: port.id, ...meta });
      this.sendIcmpError(ip, ICMP_TIME_EXCEEDED, ICMP_TIMX_INTRANS, frame, true);
      return;
    }
    const fwd = withTtl(ip, ip.ttl - 1);
    this.decision('ttl', `${this.name} TTL ${ip.ttl} → ${fwd.ttl}, header checksum ${hex(ip.checksum, 4)} → ${hex(fwd.checksum, 4)}`, meta);
    this.forward(fwd, best, { flowId: frame.flowId, parentId: frame.id }, frame);
  }

  private forward(packet: Ipv4Packet, route: Route, meta: SendMeta, frame?: Frame): void {
    const out = this.ports.get(route.iface)!;
    const nextHop = route.nextHop ?? packet.dst;
    this.decision(
      'nexthop',
      route.nextHop ? `${this.name} next hop for ${packet.dst} is ${nextHop} out ${out.id}` : `${this.name} ${packet.dst} is directly connected on ${out.id}`,
      { ifaces: [out.id], flowId: meta.flowId },
    );
    if (ipOutput(this, this.arp, out, nextHop, packet, meta) === 'too-big') {
      // RFC 1191: DF set and it doesn't fit: tell the sender the MTU that would work.
      this.drop('too-big', `${this.name} can't forward a ${packet.totalLength}-byte packet out ${out.id} (MTU ${out.mtu}) and DF is set: sending ICMP Fragmentation Needed (MTU ${out.mtu}) to ${packet.src}`, {
        iface: out.id,
        flowId: meta.flowId,
      });
      this.sendIcmpError(packet, ICMP_DEST_UNREACHABLE, ICMP_UNREACH_NEEDFRAG, frame, true, out.mtu);
    }
  }

  /** Route and send a packet this router originates. */
  private originate(packet: Ipv4Packet, meta: SendMeta): void {
    const { best } = longestPrefixMatch(this.routes, packet.dst);
    if (!best) {
      this.drop('no-route', `${this.name} cannot send to ${packet.dst}: no route`, { flowId: meta.flowId });
      return;
    }
    this.forward(packet, best, meta);
  }

  private deliverLocal(port: Port, pkt: Ipv4Packet, frame: Frame): void {
    let ip = pkt;
    if (isFragment(pkt)) {
      const whole = this.reasm.add(pkt, frame);
      if (!whole) return;
      ip = whole;
    }
    const m = ip.payload;
    if (ip.protocol === IPPROTO_ICMP && m.kind === 'icmp' && isIcmpEcho(m) && m.type === ICMP_ECHO_REQUEST) {
      // RFC 1122 3.2.2.6: reply from the address the request was sent to.
      this.decision('reply', `${this.name} answering echo request to ${ip.dst} from ${ip.src} (seq=${m.sequence})`, { ifaces: [port.id], packetId: frame.id, flowId: frame.flowId });
      const reply = makeIpv4({ src: ip.dst, dst: ip.src, protocol: IPPROTO_ICMP, identification: this.nextIpId(), payload: makeEcho(ICMP_ECHO_REPLY, m.identifier, m.sequence, m.data) });
      this.originate(reply, { flowId: this.engine.newFlowId(), parentId: frame.id });
      return;
    }
    if (m.kind === 'udp') {
      this.drop('port-closed', `${this.name}: nothing listens on UDP port ${m.dstPort}; sending ICMP Port Unreachable to ${ip.src}`, { packetId: frame.id, flowId: frame.flowId });
      this.sendIcmpError(ip, ICMP_DEST_UNREACHABLE, ICMP_UNREACH_PORT, frame, true);
      return;
    }
    if (m.kind === 'tcp') {
      if (m.flags & TCP_RST) return;
      this.drop('port-closed', `${this.name}: nothing listens on TCP port ${m.dstPort}; answering with RST`, { packetId: frame.id, flowId: frame.flowId });
      const len = m.data.length + (m.flags & TCP_SYN ? 1 : 0) + (m.flags & TCP_FIN ? 1 : 0);
      const rst =
        m.flags & TCP_ACK
          ? makeTcp(ip.dst, ip.src, { srcPort: m.dstPort, dstPort: m.srcPort, seq: m.ack, ack: 0, flags: TCP_RST, window: 0 })
          : makeTcp(ip.dst, ip.src, { srcPort: m.dstPort, dstPort: m.srcPort, seq: 0, ack: (m.seq + len) >>> 0, flags: TCP_RST | TCP_ACK, window: 0 });
      this.originate(makeIpv4({ src: ip.dst, dst: ip.src, protocol: IPPROTO_TCP, identification: this.nextIpId(), payload: rst }), { flowId: this.engine.newFlowId(), parentId: frame.id });
      return;
    }
    this.decision('local', `${this.name} received ${m.kind === 'icmp' ? icmpTypeName(m.type, m.code) : `protocol ${ip.protocol}`} from ${ip.src} addressed to itself; no handler`, {
      packetId: frame.id,
      flowId: frame.flowId,
    });
  }

  /**
   * Originate an ICMP error about `orig` back to its source.
   * RFC 1812 4.3.2.7: never about an ICMP error, a broadcast/multicast destination, or a
   * non-unicast source. RFC 1812 4.3.2.4: source address is the outgoing interface's.
   */
  private sendIcmpError(orig: Ipv4Packet, type: typeof ICMP_TIME_EXCEEDED | typeof ICMP_DEST_UNREACHABLE, code: number, frame?: Frame, quiet = false, unused = 0): void {
    const meta = { packetId: frame?.id, flowId: frame?.flowId };
    if (orig.payload.kind === 'icmp' && isIcmpError(orig.payload)) {
      this.decision('icmp-error', `${this.name} not sending ICMP error about an ICMP error (RFC 1812 4.3.2.7)`, meta);
      return;
    }
    if (orig.src === '0.0.0.0' || orig.src === LIMITED_BROADCAST || orig.src.startsWith('127.')) return;
    const { best } = longestPrefixMatch(this.routes, orig.src);
    if (!best) {
      this.drop('no-route', `${this.name} cannot send ICMP error to ${orig.src}: no route`, meta);
      return;
    }
    const src = this.ports.get(best.iface)!.ip!.addr;
    const err = makeIcmpError(type, code, encodeIpv4Datagram(orig), unused);
    const pkt = makeIpv4({ src, dst: orig.src, protocol: IPPROTO_ICMP, identification: this.nextIpId(), payload: err });
    if (!quiet) this.decision('icmp-error', `${this.name} sending ICMP ${icmpTypeName(type, code)} to ${orig.src}`, meta);
    const m: SendMeta = { flowId: this.engine.newFlowId() };
    if (frame) m.parentId = frame.id;
    this.forward(pkt, best, m);
  }

  private onArpFailed(_port: Port, ip: Ipv4, dropped: QueuedPacket[]): void {
    for (const q of dropped) {
      if (this.portByIp(q.packet.src)) continue; // our own packet (e.g. an echo reply): nothing to report
      this.decision('icmp-error', `${this.name} could not resolve next hop ${ip}; sending Host Unreachable to ${q.packet.src}`, { flowId: q.meta.flowId });
      this.sendIcmpError(q.packet, ICMP_DEST_UNREACHABLE, ICMP_UNREACH_HOST, undefined, true);
    }
  }

  private nextIpId(): number {
    this.ipId = (this.ipId + 1) & 0xffff;
    return this.ipId;
  }

  getState(): RouterState {
    return {
      id: this.id,
      name: this.name,
      kind: 'router',
      ports: portViews(this),
      routes: this.routes.map((r) => ({ prefix: cidr(r), nextHop: r.nextHop, iface: r.iface, type: r.type, active: r.active })),
      arp: this.arp.rows(),
    };
  }
}
