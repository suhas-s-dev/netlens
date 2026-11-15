/**
 * End host: one addressed interface (eth0), static IP / mask / default gateway, ARP cache,
 * replies to ARP and ICMP echo, and runs ping / traceroute sessions.
 * Hosts never forward IP packets (RFC 1122 3.3.1: host, not a router).
 */
import type { Engine } from '../core/Engine';
import type { ScheduledEvent } from '../core/EventQueue';
import { MS, SEC } from '../core/time';
import type { Frame } from '../model/frame';
import { BROADCAST_MAC, broadcastOf, inSubnet, isGroupMac, LIMITED_BROADCAST, networkOf, type Ipv4 } from '../protocols/addr';
import { hex } from '../protocols/bytes';
import { DEFAULT_PING_DATA, makeEcho } from '../protocols/icmp';
import { DEFAULT_TTL, ipv4HeaderValid, makeIpv4 } from '../protocols/ipv4';
import {
  ETHERTYPE_IPV4,
  ICMP_DEST_UNREACHABLE,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_TIME_EXCEEDED,
  IPPROTO_ICMP,
  isIcmpEcho,
  isIcmpError,
  type IcmpError,
  type Ipv4Packet,
} from '../protocols/types';
import { ArpResolver, type ArpConfig } from './ArpResolver';
import { Device, type Port, type PortInit, type SendMeta } from './Device';
import { DEFAULT_ARP_CONFIG } from './Router';
import type { HostState } from './state';
import { portViews } from './Switch';

export interface PingOptions {
  count?: number;
  intervalNs?: number;
  timeoutNs?: number;
  ttl?: number;
  /** ICMP payload size in bytes. */
  size?: number;
}

export interface TracerouteOptions {
  maxHops?: number;
  probesPerHop?: number;
  timeoutNs?: number;
}

const UNREACH_TEXT: Record<number, string> = {
  0: 'Destination Net Unreachable',
  1: 'Destination Host Unreachable',
  2: 'Destination Protocol Unreachable',
  3: 'Destination Port Unreachable',
};

function fmtMs(ns: number): string {
  return `${(ns / MS).toFixed(3)} ms`;
}

interface Session {
  readonly id: string;
  readonly app: 'ping' | 'traceroute';
  readonly identifier: number;
  readonly dst: Ipv4;
  done: boolean;
  lines: string[];
  onReply(seq: number, ip: Ipv4Packet, frame: Frame): void;
  onError(seq: number, from: Ipv4, err: IcmpError, frame: Frame): void;
  onLocalFail(seq: number, reason: string): void;
}

export class Host extends Device {
  readonly kind = 'host' as const;
  readonly arp: ArpResolver;
  private ipId: number;
  private sessions = new Map<string, Session>();
  private byIdent = new Map<number, Session>();
  private sessionCounter = 0;

  constructor(
    engine: Engine,
    id: string,
    name: string,
    ports: PortInit[],
    public gateway: Ipv4 | null,
    arpConfig: ArpConfig = DEFAULT_ARP_CONFIG,
  ) {
    super(engine, id, name, ports);
    this.arp = new ArpResolver(this, arpConfig, (_port, ip, dropped) => {
      for (const q of dropped) this.notifyLocalFail(q.packet, `Destination Host Unreachable (no ARP reply from ${ip})`);
    });
    this.ipId = engine.rng.int(0, 0xffff);
  }

  /** The host's addressed NIC (first interface with an IP). */
  get nic(): Port | undefined {
    for (const p of this.ports.values()) if (p.ip) return p;
    return undefined;
  }

  get ip(): Ipv4 | undefined {
    return this.nic?.ip?.addr;
  }

  nextIpId(): number {
    this.ipId = (this.ipId + 1) & 0xffff;
    return this.ipId;
  }

  /** IP output: choose next hop (on-link vs default gateway), then ARP + send.
   * Returns a failure reason when the packet could not even be queued. */
  sendIp(packet: Ipv4Packet, meta: SendMeta): string | null {
    const port = this.nic;
    if (!port?.ip) {
      this.drop('no-route', `${this.name} has no IP address configured`, { flowId: meta.flowId });
      return 'No IP address configured';
    }
    const { addr, prefix } = port.ip;
    if (packet.dst === LIMITED_BROADCAST || packet.dst === broadcastOf(addr, prefix)) {
      this.decision('nexthop', `${this.name} sending broadcast to ${packet.dst}`, { ifaces: [port.id], flowId: meta.flowId });
      this.sendEth(port, BROADCAST_MAC, ETHERTYPE_IPV4, packet, meta);
      return null;
    }
    let nextHop: Ipv4;
    if (inSubnet(packet.dst, addr, prefix)) {
      nextHop = packet.dst;
      this.decision('nexthop', `${this.name}: ${packet.dst} is on-link (${networkOf(addr, prefix)}/${prefix}), delivering directly`, { ifaces: [port.id], flowId: meta.flowId });
    } else if (this.gateway) {
      nextHop = this.gateway;
      this.decision('nexthop', `${this.name}: ${packet.dst} is outside ${networkOf(addr, prefix)}/${prefix}, sending via default gateway ${this.gateway}`, {
        ifaces: [port.id],
        flowId: meta.flowId,
      });
    } else {
      this.drop('no-gateway', `${this.name} cannot reach ${packet.dst}: not on-link and no default gateway`, { flowId: meta.flowId });
      return 'Network is unreachable (no default gateway)';
    }
    this.arp.sendIpv4(port, nextHop, packet, meta);
    return null;
  }

  receive(port: Port, frame: Frame): void {
    const eth = frame.eth;
    const meta = { packetId: frame.id, flowId: frame.flowId };
    if (eth.dst !== port.mac && !isGroupMac(eth.dst)) {
      // The NIC's destination filter: this is what flooded unknown unicast looks like to bystanders.
      this.drop('not-for-me', `${this.name} NIC discarded frame for ${eth.dst} (not its MAC)`, { iface: port.id, ...meta });
      return;
    }
    const p = eth.payload;
    if (p.kind === 'arp') {
      this.arp.handle(port, p, frame);
      return;
    }
    if (p.kind !== 'ipv4') {
      this.drop('unsupported', `${this.name} ignored frame with EtherType ${hex(eth.etherType, 4)}`, { iface: port.id, ...meta });
      return;
    }
    if (!ipv4HeaderValid(p)) {
      this.drop('bad-checksum', `${this.name} dropped packet from ${p.src}: bad IPv4 header checksum`, { iface: port.id, ...meta });
      return;
    }
    const mine = port.ip?.addr;
    const isBcast = p.dst === LIMITED_BROADCAST || (port.ip !== undefined && p.dst === broadcastOf(port.ip.addr, port.ip.prefix));
    if (p.dst !== mine && !isBcast) {
      this.drop('not-for-me', `${this.name} dropped packet for ${p.dst}: not its address (hosts do not forward)`, { iface: port.id, ...meta });
      return;
    }
    const m = p.payload;
    if (m.kind !== 'icmp') {
      this.drop('unsupported', `${this.name} has no handler for IP protocol ${p.protocol}`, { iface: port.id, ...meta });
      return;
    }
    if (isIcmpEcho(m) && m.type === ICMP_ECHO_REQUEST) {
      if (isBcast) {
        // RFC 1122 3.2.2.6: a host MAY silently discard echo requests to broadcast addresses.
        this.drop('unsupported', `${this.name} ignoring echo request to broadcast ${p.dst}`, { iface: port.id, ...meta });
        return;
      }
      this.decision('reply', `${this.name} replying to echo request from ${p.src} (id=${m.identifier} seq=${m.sequence})`, meta);
      const reply = makeIpv4({ src: mine!, dst: p.src, protocol: IPPROTO_ICMP, identification: this.nextIpId(), payload: makeEcho(ICMP_ECHO_REPLY, m.identifier, m.sequence, m.data) });
      this.sendIp(reply, { flowId: this.engine.newFlowId(), parentId: frame.id });
      return;
    }
    if (isIcmpEcho(m) && m.type === ICMP_ECHO_REPLY) {
      const s = this.byIdent.get(m.identifier);
      if (s) s.onReply(m.sequence, p, frame);
      else this.decision('local', `${this.name} received echo reply from ${p.src} with no matching session`, meta);
      return;
    }
    if (isIcmpError(m)) {
      // The quoted datagram identifies which of our probes this is about.
      const o = m.original;
      const ihl = ((o[0] ?? 0) & 0x0f) * 4;
      if (o.length >= ihl + 8 && o[9] === IPPROTO_ICMP && o[ihl] === ICMP_ECHO_REQUEST) {
        const ident = (o[ihl + 4]! << 8) | o[ihl + 5]!;
        const seq = (o[ihl + 6]! << 8) | o[ihl + 7]!;
        const s = this.byIdent.get(ident);
        if (s) {
          s.onError(seq, p.src, m, frame);
          return;
        }
      }
      this.decision('local', `${this.name} received ICMP error from ${p.src} not matching any session`, meta);
      return;
    }
    this.decision('local', `${this.name} received ICMP type ${m.type} from ${p.src}`, meta);
  }

  private notifyLocalFail(packet: Ipv4Packet, reason: string): void {
    const m = packet.payload;
    if (m.kind === 'icmp' && isIcmpEcho(m) && m.type === ICMP_ECHO_REQUEST) this.byIdent.get(m.identifier)?.onLocalFail(m.sequence, reason);
  }

  private newIdentifier(): number {
    let id: number;
    do id = this.engine.rng.int(1, 0xffff);
    while (this.byIdent.has(id));
    return id;
  }

  private register(s: Session): void {
    this.sessions.set(s.id, s);
    this.byIdent.set(s.identifier, s);
  }

  private nextSessionId(app: string): string {
    return `${this.id}:${app}${++this.sessionCounter}`;
  }

  /** Emit an application line (ping/traceroute output). */
  appLine(s: Session, status: 'start' | 'sent' | 'reply' | 'timeout' | 'error' | 'hop' | 'done', text: string, extra: { packetId?: string; flowId?: string } = {}): void {
    if (status !== 'sent') s.lines.push(text);
    this.engine.emit({ type: 'app', node: this.id, app: s.app, sessionId: s.id, status, text: `${this.name} ${text}`, ...extra });
  }

  /** Build and send one echo request; returns flowId, or null on local failure. */
  sendEcho(s: Session, seq: number, ttl: number, data: Uint8Array): string | null {
    const src = this.ip;
    if (!src) return null;
    const pkt = makeIpv4({ src, dst: s.dst, ttl, protocol: IPPROTO_ICMP, identification: this.nextIpId(), payload: makeEcho(ICMP_ECHO_REQUEST, s.identifier, seq, data) });
    const flowId = this.engine.newFlowId();
    const err = this.sendIp(pkt, { flowId });
    if (err) {
      s.onLocalFail(seq, err);
      return null;
    }
    return flowId;
  }

  startPing(dst: Ipv4, opts: PingOptions = {}): string {
    const s = new PingSession(this, this.nextSessionId('ping'), this.newIdentifier(), dst, opts);
    this.register(s);
    s.start();
    return s.id;
  }

  startTraceroute(dst: Ipv4, opts: TracerouteOptions = {}): string {
    const s = new TracerouteSession(this, this.nextSessionId('traceroute'), this.newIdentifier(), dst, opts);
    this.register(s);
    s.start();
    return s.id;
  }

  getState(): HostState {
    return {
      id: this.id,
      name: this.name,
      kind: 'host',
      gateway: this.gateway,
      ports: portViews(this),
      arp: this.arp.rows(),
      sessions: [...this.sessions.values()].map((s) => ({ id: s.id, app: s.app, dst: s.dst, done: s.done, lines: [...s.lines] })),
    };
  }
}

class PingSession implements Session {
  readonly app = 'ping' as const;
  done = false;
  lines: string[] = [];
  private sent = 0;
  private received = 0;
  private errors = 0;
  private outstanding = new Map<number, { sentAt: number; timer: ScheduledEvent }>();
  private readonly count: number;
  private readonly interval: number;
  private readonly timeout: number;
  private readonly ttl: number;
  private readonly data: Uint8Array;
  private rtts: number[] = [];

  constructor(
    private host: Host,
    readonly id: string,
    readonly identifier: number,
    readonly dst: Ipv4,
    o: PingOptions,
  ) {
    this.count = o.count ?? 4;
    this.interval = o.intervalNs ?? 1 * SEC;
    this.timeout = o.timeoutNs ?? 2 * SEC;
    this.ttl = o.ttl ?? DEFAULT_TTL;
    this.data = o.size === undefined ? DEFAULT_PING_DATA : Uint8Array.from({ length: o.size }, (_, i) => DEFAULT_PING_DATA[i % DEFAULT_PING_DATA.length]!);
  }

  start(): void {
    this.host.appLine(this, 'start', `PING ${this.dst}: ${this.data.length} data bytes, ttl ${this.ttl}`);
    this.sendNext();
  }

  private sendNext(): void {
    if (this.done) return;
    const seq = ++this.sent;
    const engine = this.host.engine;
    const timer = engine.schedule(this.timeout, `${this.host.name} ping timeout seq=${seq}`, () => this.onTimeout(seq), this.host.id);
    this.outstanding.set(seq, { sentAt: engine.now, timer });
    const flowId = this.host.sendEcho(this, seq, this.ttl, this.data);
    if (flowId) this.host.appLine(this, 'sent', `ping ${this.dst} icmp_seq=${seq}`, { flowId });
    if (this.sent < this.count) engine.schedule(this.interval, `${this.host.name} ping next`, () => this.sendNext(), this.host.id);
  }

  private settle(seq: number): { sentAt: number } | undefined {
    const o = this.outstanding.get(seq);
    if (!o) return undefined;
    o.timer.cancelled = true;
    this.outstanding.delete(seq);
    return o;
  }

  onReply(seq: number, ip: Ipv4Packet, frame: Frame): void {
    const o = this.settle(seq);
    const meta = { packetId: frame.id, flowId: frame.flowId };
    if (!o) {
      this.host.appLine(this, 'reply', `late or duplicate reply from ${ip.src} icmp_seq=${seq} ignored`, meta);
      return;
    }
    this.received++;
    const rtt = this.host.engine.now - o.sentAt;
    this.rtts.push(rtt);
    this.host.appLine(this, 'reply', `${ip.totalLength - 20 - 8} bytes from ${ip.src}: icmp_seq=${seq} ttl=${ip.ttl} time=${fmtMs(rtt)}`, meta);
    this.maybeFinish();
  }

  onError(seq: number, from: Ipv4, err: IcmpError, frame: Frame): void {
    if (!this.settle(seq)) return;
    this.errors++;
    const what = err.type === ICMP_TIME_EXCEEDED ? 'Time to live exceeded' : err.type === ICMP_DEST_UNREACHABLE ? (UNREACH_TEXT[err.code] ?? `Unreachable code ${err.code}`) : `ICMP type ${err.type}`;
    this.host.appLine(this, 'error', `From ${from} icmp_seq=${seq} ${what}`, { packetId: frame.id, flowId: frame.flowId });
    this.maybeFinish();
  }

  onLocalFail(seq: number, reason: string): void {
    if (!this.settle(seq)) return;
    this.errors++;
    this.host.appLine(this, 'error', `From ${this.host.ip ?? '?'} icmp_seq=${seq} ${reason}`);
    this.maybeFinish();
  }

  private onTimeout(seq: number): void {
    if (!this.outstanding.delete(seq)) return;
    this.host.appLine(this, 'timeout', `Request timeout for icmp_seq ${seq}`);
    this.maybeFinish();
  }

  private maybeFinish(): void {
    if (this.done || this.sent < this.count || this.outstanding.size) return;
    this.done = true;
    const loss = Math.round(((this.count - this.received) / this.count) * 100);
    let text = `--- ${this.dst} ping statistics --- ${this.count} packets transmitted, ${this.received} received, ${this.errors ? `+${this.errors} errors, ` : ''}${loss}% packet loss`;
    if (this.rtts.length) {
      const min = Math.min(...this.rtts);
      const max = Math.max(...this.rtts);
      const avg = this.rtts.reduce((a, b) => a + b, 0) / this.rtts.length;
      text += `, rtt min/avg/max = ${(min / MS).toFixed(3)}/${(avg / MS).toFixed(3)}/${(max / MS).toFixed(3)} ms`;
    }
    this.host.appLine(this, 'done', text);
  }
}

/** ICMP-echo traceroute (Windows tracert style; UDP probes need Phase 2). Probes are sent
 * one at a time: TTL 1..maxHops, `probesPerHop` per hop, stopping once the destination answers
 * or an unreachable comes back. */
class TracerouteSession implements Session {
  readonly app = 'traceroute' as const;
  done = false;
  lines: string[] = [];
  private ttl = 1;
  private probe = 0;
  private seq = 0;
  private current?: { seq: number; sentAt: number; timer: ScheduledEvent };
  private results: string[] = [];
  private hopAddr: Ipv4 | null = null;
  private finished = false;
  private readonly maxHops: number;
  private readonly probes: number;
  private readonly timeout: number;

  constructor(
    private host: Host,
    readonly id: string,
    readonly identifier: number,
    readonly dst: Ipv4,
    o: TracerouteOptions,
  ) {
    this.maxHops = o.maxHops ?? 30;
    this.probes = o.probesPerHop ?? 3;
    this.timeout = o.timeoutNs ?? 2 * SEC;
  }

  start(): void {
    this.host.appLine(this, 'start', `traceroute to ${this.dst}, ${this.maxHops} hops max, ICMP echo probes`);
    this.sendProbe();
  }

  private sendProbe(): void {
    const seq = ++this.seq;
    const engine = this.host.engine;
    const timer = engine.schedule(this.timeout, `${this.host.name} traceroute timeout`, () => this.onTimeout(seq), this.host.id);
    this.current = { seq, sentAt: engine.now, timer };
    const flowId = this.host.sendEcho(this, seq, this.ttl, DEFAULT_PING_DATA);
    if (flowId) this.host.appLine(this, 'sent', `traceroute probe ttl=${this.ttl} seq=${seq}`, { flowId });
  }

  private take(seq: number): number | undefined {
    if (!this.current || this.current.seq !== seq) return undefined;
    this.current.timer.cancelled = true;
    const rtt = this.host.engine.now - this.current.sentAt;
    this.current = undefined;
    return rtt;
  }

  onReply(seq: number, ip: Ipv4Packet): void {
    const rtt = this.take(seq);
    if (rtt === undefined) return;
    this.hopAddr ??= ip.src;
    this.results.push(fmtMs(rtt));
    this.finished = true;
    this.next();
  }

  onError(seq: number, from: Ipv4, err: IcmpError): void {
    const rtt = this.take(seq);
    if (rtt === undefined) return;
    this.hopAddr ??= from;
    if (err.type === ICMP_DEST_UNREACHABLE) {
      this.results.push(`${fmtMs(rtt)} ${err.code === 0 ? '!N' : err.code === 1 ? '!H' : `!<${err.code}>`}`);
      this.finished = true;
    } else {
      this.results.push(fmtMs(rtt));
    }
    this.next();
  }

  onLocalFail(seq: number, reason: string): void {
    if (this.take(seq) === undefined) return;
    this.results.push('!H');
    this.finished = true;
    this.host.appLine(this, 'error', `traceroute: ${reason}`);
    this.next();
  }

  private onTimeout(seq: number): void {
    if (!this.current || this.current.seq !== seq) return;
    this.current = undefined;
    this.results.push('*');
    this.next();
  }

  private next(): void {
    if (++this.probe < this.probes) {
      this.sendProbe();
      return;
    }
    this.host.appLine(this, 'hop', `${String(this.ttl).padStart(2)}  ${this.hopAddr ?? '*'}  ${this.results.join('  ')}`);
    if (this.finished || this.ttl >= this.maxHops) {
      this.done = true;
      this.host.appLine(this, 'done', this.finished ? `traceroute to ${this.dst} complete` : `traceroute to ${this.dst}: max hops reached`);
      return;
    }
    this.ttl++;
    this.probe = 0;
    this.results = [];
    this.hopAddr = null;
    this.sendProbe();
  }
}
