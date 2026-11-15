/**
 * End host: one addressed interface (eth0), static IP / mask / default gateway, ARP cache,
 * replies to ARP and ICMP echo, and runs ping / traceroute sessions.
 * Hosts never forward IP packets (RFC 1122 3.3.1: host, not a router).
 */
import type { Engine } from '../core/Engine';
import type { ScheduledEvent } from '../core/EventQueue';
import { MS, SEC } from '../core/time';
import type { Frame } from '../model/frame';
import { BROADCAST_MAC, broadcastOf, bytesToIp, inSubnet, isGroupMac, LIMITED_BROADCAST, networkOf, type Ipv4 } from '../protocols/addr';
import { hex } from '../protocols/bytes';
import { DEFAULT_PING_DATA, makeEcho, makeIcmpError } from '../protocols/icmp';
import { DEFAULT_TTL, encodeIpv4Datagram, ipv4HeaderValid, isFragment, makeIpv4 } from '../protocols/ipv4';
import {
  ETHERTYPE_IPV4,
  ICMP_DEST_UNREACHABLE,
  ICMP_ECHO_REPLY,
  ICMP_ECHO_REQUEST,
  ICMP_TIME_EXCEEDED,
  ICMP_TIMX_REASS,
  ICMP_UNREACH_NEEDFRAG,
  IPPROTO_ICMP,
  IPV4_FLAG_DF,
  isIcmpEcho,
  isIcmpError,
  type IcmpError,
  type Ipv4Packet,
} from '../protocols/types';
import { ArpResolver, type ArpConfig } from './ArpResolver';
import { ipOutput, Reassembler } from './ipOutput';
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
  /** Set Don't Fragment (like `ping -M do` / `ping -f -l` on Windows). */
  df?: boolean;
}

export interface MtrOptions {
  rounds?: number;
  maxHops?: number;
  timeoutNs?: number;
}

/** RFC 1191 6.3: learned PMTU estimates are aged out (after 10 minutes). */
const PMTU_AGE_NS = 600 * SEC;

export interface TracerouteOptions {
  maxHops?: number;
  probesPerHop?: number;
  timeoutNs?: number;
}

const UNREACH_TEXT: Record<number, string> = {
  4: 'Frag needed and DF set',
  0: 'Destination Net Unreachable',
  1: 'Destination Host Unreachable',
  2: 'Destination Protocol Unreachable',
  3: 'Destination Port Unreachable',
};

function icmpErrorText(err: IcmpError): string {
  if (err.type === ICMP_TIME_EXCEEDED) return err.code === ICMP_TIMX_REASS ? 'Fragment reassembly time exceeded' : 'Time to live exceeded';
  if (err.type === ICMP_DEST_UNREACHABLE && err.code === ICMP_UNREACH_NEEDFRAG) return `Frag needed and DF set (mtu = ${err.unused & 0xffff})`;
  if (err.type === ICMP_DEST_UNREACHABLE) return UNREACH_TEXT[err.code] ?? `Unreachable code ${err.code}`;
  return `ICMP type ${err.type}`;
}

function fmtMs(ns: number): string {
  return `${(ns / MS).toFixed(3)} ms`;
}

interface Session {
  readonly id: string;
  readonly app: 'ping' | 'traceroute' | 'pmtud' | 'mtr';
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
  private pmtu = new Map<Ipv4, { mtu: number; expiresAt: number }>();
  private reasm: Reassembler;

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
    this.reasm = new Reassembler(this, (first) => {
      // RFC 1122 3.3.2: report a timed-out reassembly to the sender if fragment 0 arrived.
      if (!first || !this.ip) return;
      const err = makeIcmpError(ICMP_TIME_EXCEEDED, ICMP_TIMX_REASS, encodeIpv4Datagram(first));
      this.sendIp(makeIpv4({ src: this.ip, dst: first.src, protocol: IPPROTO_ICMP, identification: this.nextIpId(), payload: err }), { flowId: this.engine.newFlowId() });
    });
  }

  /** Effective MTU towards `dst`: the NIC's MTU, lowered by any learned path MTU. */
  pathMtu(dst: Ipv4, port = this.nic): number {
    const base = port?.mtu ?? 1500;
    const e = this.pmtu.get(dst);
    if (!e) return base;
    if (e.expiresAt <= this.engine.now) {
      this.pmtu.delete(dst);
      return base;
    }
    return Math.min(base, e.mtu);
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
    const mtu = this.pathMtu(packet.dst, port);
    if (ipOutput(this, this.arp, port, nextHop, packet, meta, mtu) === 'too-big') {
      this.drop('too-big', `${this.name} won't send a ${packet.totalLength}-byte packet with DF set: the MTU towards ${packet.dst} is ${mtu}`, { flowId: meta.flowId });
      return `Message too long (mtu = ${mtu})`;
    }
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
    if (isFragment(p)) {
      const whole = this.reasm.add(p, frame);
      if (!whole) return;
      this.handleIp(port, whole, frame, isBcast);
      return;
    }
    this.handleIp(port, p, frame, isBcast);
  }

  private handleIp(port: Port, p: Ipv4Packet, frame: Frame, isBcast: boolean): void {
    const meta = { packetId: frame.id, flowId: frame.flowId };
    const mine = port.ip?.addr;
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
      if (m.type === ICMP_DEST_UNREACHABLE && m.code === ICMP_UNREACH_NEEDFRAG && o.length >= 20) {
        // RFC 1191: remember the smaller path MTU for that destination.
        const dst = bytesToIp(o, 16);
        const mtu = m.unused & 0xffff;
        if (mtu >= 68 && mtu < this.pathMtu(dst)) {
          const had = this.pmtu.has(dst);
          this.pmtu.set(dst, { mtu, expiresAt: this.engine.now + PMTU_AGE_NS });
          this.table('pmtu', had ? 'update' : 'add', dst, `${this.name} learned path MTU to ${dst} is ${mtu} (from ${p.src})`, meta);
        }
      }
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
  sendEcho(s: Session, seq: number, ttl: number, data: Uint8Array, df = false): string | null {
    const src = this.ip;
    if (!src) return null;
    const pkt = makeIpv4({ src, dst: s.dst, ttl, protocol: IPPROTO_ICMP, identification: this.nextIpId(), flags: df ? IPV4_FLAG_DF : 0, payload: makeEcho(ICMP_ECHO_REQUEST, s.identifier, seq, data) });
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

  startPmtud(dst: Ipv4): string {
    const s = new PmtudSession(this, this.nextSessionId('pmtud'), this.newIdentifier(), dst);
    this.register(s);
    s.start();
    return s.id;
  }

  startMtr(dst: Ipv4, opts: MtrOptions = {}): string {
    const s = new MtrSession(this, this.nextSessionId('mtr'), this.newIdentifier(), dst, opts);
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
      pmtu: [...this.pmtu.entries()].filter(([, e]) => e.expiresAt > this.engine.now).map(([dst, e]) => ({ dst, mtu: e.mtu, expiresIn: e.expiresAt - this.engine.now })),
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
  private readonly df: boolean;
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
    this.df = o.df ?? false;
    this.data = o.size === undefined ? DEFAULT_PING_DATA : Uint8Array.from({ length: o.size }, (_, i) => DEFAULT_PING_DATA[i % DEFAULT_PING_DATA.length]!);
  }

  start(): void {
    this.host.appLine(this, 'start', `PING ${this.dst}: ${this.data.length} data bytes (${this.data.length + 28}-byte packets), ttl ${this.ttl}${this.df ? ', DF set' : ''}`);
    this.sendNext();
  }

  private sendNext(): void {
    if (this.done) return;
    const seq = ++this.sent;
    const engine = this.host.engine;
    const timer = engine.schedule(this.timeout, `${this.host.name} ping timeout seq=${seq}`, () => this.onTimeout(seq), this.host.id);
    this.outstanding.set(seq, { sentAt: engine.now, timer });
    const flowId = this.host.sendEcho(this, seq, this.ttl, this.data, this.df);
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
    const what = icmpErrorText(err);
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

/**
 * Path-MTU discovery, tracepath-style: send DF-set echo requests as big as the local MTU;
 * every "Fragmentation Needed" names a smaller next-hop MTU, so retry at that size until an
 * echo reply proves the whole path carries it (RFC 1191).
 */
class PmtudSession implements Session {
  readonly app = 'pmtud' as const;
  done = false;
  lines: string[] = [];
  private size: number;
  private seq = 0;
  private current?: { seq: number; timer: ScheduledEvent };
  private tries = 0;

  constructor(
    private host: Host,
    readonly id: string,
    readonly identifier: number,
    readonly dst: Ipv4,
  ) {
    this.size = host.nic?.mtu ?? 1500;
  }

  start(): void {
    this.host.appLine(this, 'start', `PMTUD to ${this.dst}: probing with DF set, starting at my MTU ${this.size}`);
    this.probe();
  }

  private probe(): void {
    if (++this.tries > 8) return this.finish(`gave up after ${this.tries - 1} probes`);
    const seq = ++this.seq;
    const timer = this.host.engine.schedule(2 * SEC, `${this.host.name} pmtud timeout`, () => this.onTimeout(seq), this.host.id);
    this.current = { seq, timer };
    const data = Uint8Array.from({ length: this.size - 28 }, (_, i) => DEFAULT_PING_DATA[i % DEFAULT_PING_DATA.length]!);
    this.host.appLine(this, 'hop', `probe ${this.size} bytes (DF)`);
    this.host.sendEcho(this, seq, DEFAULT_TTL, data, true);
  }

  private take(seq: number): boolean {
    if (!this.current || this.current.seq !== seq) return false;
    this.current.timer.cancelled = true;
    this.current = undefined;
    return true;
  }

  onReply(seq: number, ip: Ipv4Packet): void {
    if (!this.take(seq)) return;
    this.host.appLine(this, 'reply', `${this.size} bytes reached ${ip.src} without fragmentation`);
    this.finish(`path MTU to ${this.dst} = ${this.size}`);
  }

  onError(seq: number, from: Ipv4, err: IcmpError): void {
    if (!this.take(seq)) return;
    if (err.type === ICMP_DEST_UNREACHABLE && err.code === ICMP_UNREACH_NEEDFRAG) {
      const mtu = err.unused & 0xffff;
      this.host.appLine(this, 'error', `${from} says: too big, next-hop MTU ${mtu}`);
      if (mtu >= 68 && mtu < this.size) {
        this.size = mtu;
        this.probe();
        return;
      }
    } else {
      this.host.appLine(this, 'error', `From ${from}: ${icmpErrorText(err)}`);
    }
    this.finish(`stopped at ${this.size} bytes`);
  }

  onLocalFail(seq: number, reason: string): void {
    if (!this.take(seq)) return;
    const m = /mtu = (\d+)/.exec(reason);
    if (m && Number(m[1]) < this.size) {
      this.size = Number(m[1]);
      this.host.appLine(this, 'error', `already known: path MTU is at most ${this.size}`);
      this.probe();
      return;
    }
    this.host.appLine(this, 'error', reason);
    this.finish(`stopped at ${this.size} bytes`);
  }

  private onTimeout(seq: number): void {
    if (!this.current || this.current.seq !== seq) return;
    this.current = undefined;
    this.host.appLine(this, 'timeout', `no answer to the ${this.size}-byte probe`);
    this.finish(`no reply: path MTU unknown (≤ ${this.size})`);
  }

  private finish(text: string): void {
    if (this.done) return;
    this.done = true;
    this.host.appLine(this, 'done', text);
  }
}

interface HopStat {
  addr: Ipv4 | null;
  sent: number;
  recv: number;
  rtts: number[];
}

/**
 * MTR ("my traceroute"): traceroute repeated in rounds, one probe per hop per round, then a
 * per-hop table of loss and latency. Loss at an intermediate hop that does not continue to
 * later hops usually means that router rate-limits ICMP, not real packet loss.
 */
class MtrSession implements Session {
  readonly app = 'mtr' as const;
  done = false;
  lines: string[] = [];
  private round = 0;
  private ttl = 1;
  private seq = 0;
  private lastHop: number;
  private stats: HopStat[] = [];
  private current?: { seq: number; sentAt: number; timer: ScheduledEvent };
  private readonly rounds: number;
  private readonly timeout: number;

  constructor(
    private host: Host,
    readonly id: string,
    readonly identifier: number,
    readonly dst: Ipv4,
    o: MtrOptions,
  ) {
    this.rounds = o.rounds ?? 5;
    this.lastHop = o.maxHops ?? 30;
    this.timeout = o.timeoutNs ?? 1 * SEC;
  }

  start(): void {
    this.host.appLine(this, 'start', `mtr to ${this.dst}: ${this.rounds} rounds, one probe per hop per round`);
    this.round = 1;
    this.send();
  }

  private stat(ttl: number): HopStat {
    return (this.stats[ttl - 1] ??= { addr: null, sent: 0, recv: 0, rtts: [] });
  }

  private send(): void {
    const seq = ++this.seq;
    const engine = this.host.engine;
    const timer = engine.schedule(this.timeout, `${this.host.name} mtr timeout`, () => this.onTimeout(seq), this.host.id);
    this.current = { seq, sentAt: engine.now, timer };
    this.stat(this.ttl).sent++;
    this.host.sendEcho(this, seq, this.ttl, DEFAULT_PING_DATA);
  }

  private take(seq: number): number | undefined {
    if (!this.current || this.current.seq !== seq) return undefined;
    this.current.timer.cancelled = true;
    const rtt = this.host.engine.now - this.current.sentAt;
    this.current = undefined;
    return rtt;
  }

  private record(rtt: number, from: Ipv4, final: boolean): void {
    const h = this.stat(this.ttl);
    h.addr ??= from;
    h.recv++;
    h.rtts.push(rtt);
    if (final) this.lastHop = Math.min(this.lastHop, this.ttl);
    this.next();
  }

  onReply(seq: number, ip: Ipv4Packet): void {
    const rtt = this.take(seq);
    if (rtt !== undefined) this.record(rtt, ip.src, true);
  }

  onError(seq: number, from: Ipv4, err: IcmpError): void {
    const rtt = this.take(seq);
    if (rtt === undefined) return;
    this.record(rtt, from, err.type === ICMP_DEST_UNREACHABLE);
  }

  onLocalFail(seq: number, reason: string): void {
    if (this.take(seq) === undefined) return;
    this.host.appLine(this, 'error', reason);
    this.lastHop = Math.min(this.lastHop, this.ttl);
    this.next();
  }

  private onTimeout(seq: number): void {
    if (!this.current || this.current.seq !== seq) return;
    this.current = undefined;
    this.next();
  }

  private next(): void {
    if (this.ttl < this.lastHop) {
      this.ttl++;
      this.send();
      return;
    }
    this.host.appLine(this, 'hop', `round ${this.round}/${this.rounds} done`);
    if (this.round >= this.rounds) {
      this.report();
      return;
    }
    this.round++;
    this.ttl = 1;
    this.host.engine.schedule(200 * MS, `${this.host.name} mtr next round`, () => this.send(), this.host.id);
  }

  private report(): void {
    this.done = true;
    this.host.appLine(this, 'hop', 'HOST                 Loss%  Snt   Avg   Best  Wrst');
    this.stats.slice(0, this.lastHop).forEach((h, i) => {
      const loss = h.sent ? ((h.sent - h.recv) / h.sent) * 100 : 0;
      const ms = (v: number) => (v / MS).toFixed(1).padStart(5);
      const avg = h.rtts.length ? h.rtts.reduce((a, b) => a + b, 0) / h.rtts.length : 0;
      const row = h.rtts.length ? `${ms(avg)} ${ms(Math.min(...h.rtts))} ${ms(Math.max(...h.rtts))}` : '    -     -     -';
      this.host.appLine(this, 'hop', `${String(i + 1).padStart(2)}. ${(h.addr ?? '???').padEnd(16)} ${loss.toFixed(1).padStart(5)}% ${String(h.sent).padStart(4)} ${row}`);
    });
    this.host.appLine(this, 'done', `mtr to ${this.dst} complete`);
  }
}
