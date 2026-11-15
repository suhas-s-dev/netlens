/**
 * ARP cache + resolution queue shared by hosts and routers (one table, keyed per interface).
 *
 * Behaviour:
 * - RFC 826 "merge" algorithm: if the sender is already cached, update it (even when the
 *   request is not for us); add a new entry only when we are the target.
 * - RFC 1122 2.3.2.2: packets waiting on resolution are queued (we keep up to `maxQueue`
 *   per destination, dropping the oldest), and requests are rate-limited to one per
 *   `retryNs` per destination.
 * - RFC 1122 2.3.2.1: entries time out after `timeoutNs`. We only refresh on ARP traffic,
 *   not on use (like a plain RFC 826 implementation; Linux NUD would revalidate instead).
 */
import type { ScheduledEvent } from '../core/EventQueue';
import { formatDuration } from '../core/time';
import type { Frame } from '../model/frame';
import { BROADCAST_MAC, type Ipv4, type Mac } from '../protocols/addr';
import { makeArpReply, makeArpRequest } from '../protocols/arp';
import { ARP_REQUEST, ETHERTYPE_ARP, ETHERTYPE_IPV4, type ArpPacket, type Ipv4Packet } from '../protocols/types';
import type { Device, Port, SendMeta } from './Device';
import type { ArpRow } from './state';

export interface ArpConfig {
  timeoutNs: number;
  retryNs: number;
  maxAttempts: number;
  maxQueue: number;
}

export interface QueuedPacket {
  packet: Ipv4Packet;
  meta: SendMeta;
}

interface ArpEntry {
  iface: string;
  ip: Ipv4;
  mac: Mac;
  expiresAt: number;
  timer: ScheduledEvent;
}

interface Pending {
  iface: string;
  ip: Ipv4;
  attempts: number;
  queue: QueuedPacket[];
  timer?: ScheduledEvent;
  nextAt: number;
  flowId: string;
}

const key = (iface: string, ip: Ipv4) => `${iface}|${ip}`;

export class ArpResolver {
  private entries = new Map<string, ArpEntry>();
  private pending = new Map<string, Pending>();

  constructor(
    private dev: Device,
    readonly config: ArpConfig,
    private onFail: (port: Port, ip: Ipv4, dropped: QueuedPacket[]) => void,
  ) {}

  private get engine() {
    return this.dev.engine;
  }

  lookup(iface: string, ip: Ipv4): Mac | undefined {
    return this.entries.get(key(iface, ip))?.mac;
  }

  /** Send an IPv4 packet to `nextHop` out of `port`, resolving its MAC first if needed. */
  sendIpv4(port: Port, nextHop: Ipv4, packet: Ipv4Packet, meta: SendMeta): void {
    const k = key(port.id, nextHop);
    const e = this.entries.get(k);
    if (e) {
      this.dev.table('arp', 'hit', nextHop, `${this.dev.name} ARP cache hit: ${nextHop} is at ${e.mac} (${port.id})`, { iface: port.id, flowId: meta.flowId });
      this.dev.sendEth(port, e.mac, ETHERTYPE_IPV4, packet, meta);
      return;
    }
    let p = this.pending.get(k);
    if (!p) {
      p = { iface: port.id, ip: nextHop, attempts: 0, queue: [], nextAt: 0, flowId: this.engine.newFlowId() };
      this.pending.set(k, p);
      this.dev.table('arp', 'pending', nextHop, `${this.dev.name} has no ARP entry for ${nextHop}; queuing packet and resolving`, { iface: port.id, flowId: meta.flowId });
      p.queue.push({ packet, meta });
      this.request(port, p);
      return;
    }
    if (p.queue.length >= this.config.maxQueue) {
      const old = p.queue.shift()!;
      this.dev.drop('queue-full', `${this.dev.name} ARP queue for ${nextHop} full (${this.config.maxQueue}); dropped oldest waiting packet`, { iface: port.id, flowId: old.meta.flowId });
    }
    p.queue.push({ packet, meta });
    this.dev.decision('queue', `${this.dev.name} queued packet for ${nextHop} while ARP is pending (${p.queue.length} waiting)`, { flowId: meta.flowId });
  }

  private request(port: Port, p: Pending): void {
    if (!port.ip) return;
    p.attempts++;
    p.nextAt = this.engine.now + this.config.retryNs;
    this.dev.decision(
      'nexthop',
      `${this.dev.name} broadcasting ARP request: who has ${p.ip}? tell ${port.ip.addr} (attempt ${p.attempts}/${this.config.maxAttempts})`,
      { ifaces: [port.id], flowId: p.flowId },
    );
    this.dev.sendEth(port, BROADCAST_MAC, ETHERTYPE_ARP, makeArpRequest(port.mac, port.ip.addr, p.ip), { flowId: p.flowId });
    p.timer = this.engine.schedule(this.config.retryNs, `${this.dev.name} ARP retry ${p.ip}`, () => this.retry(port, p), this.dev.id);
  }

  private retry(port: Port, p: Pending): void {
    const k = key(p.iface, p.ip);
    if (this.pending.get(k) !== p) return;
    if (p.attempts < this.config.maxAttempts) {
      this.request(port, p);
      return;
    }
    this.pending.delete(k);
    this.dev.table('arp', 'remove', p.ip, `${this.dev.name} ARP for ${p.ip} failed after ${p.attempts} attempts`, { iface: p.iface });
    this.dev.drop(
      'arp-failed',
      `${this.dev.name} dropping ${p.queue.length} packet(s) queued for ${p.ip}: no ARP reply`,
      { iface: p.iface, flowId: p.queue[0]?.meta.flowId },
    );
    this.onFail(port, p.ip, p.queue);
  }

  /** Process a received ARP packet (RFC 826 packet reception algorithm). */
  handle(port: Port, arp: ArpPacket, frame: Frame): void {
    const dev = this.dev;
    if (arp.htype !== 1 || arp.ptype !== ETHERTYPE_IPV4) {
      dev.drop('unsupported', `${dev.name} ignored ARP with unsupported hardware/protocol type`, { iface: port.id, packetId: frame.id });
      return;
    }
    const isRequest = arp.oper === ARP_REQUEST;
    const kind = isRequest ? 'request' : 'reply';
    const k = key(port.id, arp.spa);
    let merged = false;
    const existing = this.entries.get(k);
    if (existing && arp.spa !== '0.0.0.0') {
      merged = true;
      const changed = existing.mac !== arp.sha;
      this.upsert(port, arp.spa, arp.sha);
      dev.table(
        'arp',
        changed ? 'update' : 'refresh',
        arp.spa,
        changed
          ? `${dev.name} updated ARP entry ${arp.spa}: ${existing.mac} → ${arp.sha} (from ARP ${kind})`
          : `${dev.name} refreshed ARP entry ${arp.spa} → ${arp.sha} (from ARP ${kind})`,
        { iface: port.id, packetId: frame.id, flowId: frame.flowId },
      );
    }
    const forMe = port.ip !== undefined && arp.tpa === port.ip.addr;
    if (!forMe) {
      if (!merged) {
        dev.drop('not-for-me', `${dev.name} ignored ARP ${kind} for ${arp.tpa} (not its address on ${dev.portLabel(port)})`, {
          iface: port.id,
          packetId: frame.id,
          flowId: frame.flowId,
        });
      }
      return;
    }
    if (!merged && arp.spa !== '0.0.0.0') {
      this.upsert(port, arp.spa, arp.sha);
      dev.table('arp', 'add', arp.spa, `${dev.name} learned ${arp.spa} is at ${arp.sha} (from ARP ${kind})`, {
        iface: port.id,
        packetId: frame.id,
        flowId: frame.flowId,
      });
    }
    if (isRequest) {
      dev.decision('reply', `${dev.name} replying to ARP: ${port.ip!.addr} is at ${port.mac}`, { ifaces: [port.id], packetId: frame.id, flowId: frame.flowId });
      dev.sendEth(port, arp.sha, ETHERTYPE_ARP, makeArpReply(port.mac, port.ip!.addr, arp.sha, arp.spa), { flowId: frame.flowId, parentId: frame.id });
    }
    this.flush(port, arp.spa);
  }

  private upsert(port: Port, ip: Ipv4, mac: Mac): void {
    const k = key(port.id, ip);
    const old = this.entries.get(k);
    if (old) old.timer.cancelled = true;
    const expiresAt = this.engine.now + this.config.timeoutNs;
    const timer = this.engine.schedule(
      this.config.timeoutNs,
      `${this.dev.name} ARP aging ${ip}`,
      () => {
        const e = this.entries.get(k);
        if (e && e.expiresAt <= this.engine.now) {
          this.entries.delete(k);
          this.dev.table('arp', 'remove', ip, `${this.dev.name} ARP entry ${ip} → ${e.mac} aged out after ${formatDuration(this.config.timeoutNs)}`, { iface: port.id });
        }
      },
      this.dev.id,
    );
    this.entries.set(k, { iface: port.id, ip, mac, expiresAt, timer });
  }

  private flush(port: Port, ip: Ipv4): void {
    const k = key(port.id, ip);
    const p = this.pending.get(k);
    const e = this.entries.get(k);
    if (!p || !e) return;
    this.pending.delete(k);
    if (p.timer) p.timer.cancelled = true;
    this.dev.decision('queue', `${this.dev.name} resolved ${ip} → ${e.mac}; sending ${p.queue.length} queued packet(s)`, { ifaces: [port.id], flowId: p.queue[0]?.meta.flowId });
    for (const q of p.queue) this.dev.sendEth(port, e.mac, ETHERTYPE_IPV4, q.packet, q.meta);
  }

  /** Remove all entries (and cancel resolutions). */
  clear(): void {
    for (const e of this.entries.values()) e.timer.cancelled = true;
    for (const p of this.pending.values()) if (p.timer) p.timer.cancelled = true;
    this.entries.clear();
    this.pending.clear();
  }

  rows(): ArpRow[] {
    const now = this.engine.now;
    const rows: ArpRow[] = [];
    for (const e of this.entries.values()) rows.push({ iface: e.iface, ip: e.ip, mac: e.mac, state: 'reachable', expiresIn: e.expiresAt - now, queued: 0 });
    for (const p of this.pending.values())
      rows.push({ iface: p.iface, ip: p.ip, mac: null, state: 'incomplete', expiresIn: Math.max(0, p.nextAt - now), queued: p.queue.length });
    return rows.sort((a, b) => (a.iface + a.ip).localeCompare(b.iface + b.ip, 'en', { numeric: true }));
  }
}
