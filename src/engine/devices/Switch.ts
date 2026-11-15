/**
 * Unmanaged L2 learning switch (IEEE 802.1D transparent bridging, no STP/VLANs in the MVP).
 * - Learns source MAC per ingress port; entries age out after `agingNs` (802.1D default 300 s).
 * - Forwards known unicast out the learned port; floods broadcast/multicast and unknown
 *   unicast out every *linked* port except the ingress port.
 * - Filters (drops) frames whose destination was learned on the ingress port.
 * Store-and-forward with zero processing delay: the frame is forwarded as soon as it has
 * fully arrived. Note: without STP, a physical loop will cause a broadcast storm (by design).
 */
import type { ScheduledEvent } from '../core/EventQueue';
import { formatDuration, SEC } from '../core/time';
import type { Frame } from '../model/frame';
import { isBroadcastMac, isGroupMac, type Mac } from '../protocols/addr';
import { summarizeFrame } from '../protocols/describe';
import { Device, type Port, type PortInit } from './Device';
import type { Engine } from '../core/Engine';
import type { SwitchState } from './state';

export const DEFAULT_MAC_AGING_NS = 300 * SEC;

interface MacEntry {
  mac: Mac;
  port: string;
  expiresAt: number;
  timer: ScheduledEvent;
}

export class Switch extends Device {
  readonly kind = 'switch' as const;
  private macTable = new Map<Mac, MacEntry>();

  constructor(engine: Engine, id: string, name: string, ports: PortInit[], readonly agingNs = DEFAULT_MAC_AGING_NS) {
    super(engine, id, name, ports);
  }

  override portLabel(port: Port | string): string {
    return `port ${typeof port === 'string' ? port : port.id}`;
  }

  receive(port: Port, frame: Frame): void {
    const eth = frame.eth;
    this.learn(eth.src, port, frame);

    const others = [...this.ports.values()].filter((p) => p !== port && p.linkId);
    const flood = (why: string) => {
      const ids = others.map((p) => p.id);
      this.decision(
        'flood',
        others.length
          ? `${this.name} flooding ${why} out ${ids.length === 1 ? 'port' : 'ports'} ${ids.join(',')}`
          : `${this.name} would flood ${why}, but no other ports are connected`,
        { ifaces: ids, packetId: frame.id, flowId: frame.flowId },
      );
      for (const p of others) this.sendEth(p, eth.dst, eth.etherType, eth.payload, { flowId: frame.flowId, parentId: frame.id });
    };

    if (isGroupMac(eth.dst)) {
      flood(isBroadcastMac(eth.dst) ? 'broadcast frame' : `multicast frame to ${eth.dst}`);
      return;
    }
    const entry = this.macTable.get(eth.dst);
    if (!entry) {
      flood(`unknown unicast to ${eth.dst}`);
      return;
    }
    if (entry.port === port.id) {
      this.drop('filtered', `${this.name} filtered frame to ${eth.dst}: destination is on ingress port ${port.id}`, {
        iface: port.id,
        packetId: frame.id,
        flowId: frame.flowId,
      });
      return;
    }
    const out = this.ports.get(entry.port)!;
    this.table('mac', 'hit', eth.dst, `${this.name} MAC table hit: ${eth.dst} on port ${out.id}`, { iface: out.id, packetId: frame.id, flowId: frame.flowId });
    this.decision('forward', `${this.name} forwarding ${summarizeFrame(eth)} to ${eth.dst} out port ${out.id}`, {
      ifaces: [out.id],
      packetId: frame.id,
      flowId: frame.flowId,
    });
    this.sendEth(out, eth.dst, eth.etherType, eth.payload, { flowId: frame.flowId, parentId: frame.id });
  }

  private learn(src: Mac, port: Port, frame: Frame): void {
    // Group addresses are never valid source addresses (802.1D 7.8).
    if (isGroupMac(src)) return;
    const old = this.macTable.get(src);
    if (old) old.timer.cancelled = true;
    const expiresAt = this.engine.now + this.agingNs;
    const timer = this.engine.schedule(
      this.agingNs,
      `${this.name} MAC aging ${src}`,
      () => {
        const e = this.macTable.get(src);
        if (e && e.expiresAt <= this.engine.now) {
          this.macTable.delete(src);
          this.table_('remove', src, `${this.name} aged out ${src} on port ${e.port} (no frames for ${formatDuration(this.agingNs)})`, e.port);
        }
      },
      this.id,
    );
    this.macTable.set(src, { mac: src, port: port.id, expiresAt, timer });
    const meta = { packetId: frame.id, flowId: frame.flowId };
    if (!old) this.table_('add', src, `${this.name} learned ${src} on port ${port.id}`, port.id, meta);
    else if (old.port !== port.id) this.table_('update', src, `${this.name} moved ${src} from port ${old.port} to port ${port.id}`, port.id, meta);
    else this.table_('refresh', src, `${this.name} refreshed ${src} on port ${port.id}`, port.id, meta);
  }

  private table_(op: 'add' | 'update' | 'refresh' | 'remove', mac: Mac, text: string, iface: string, meta: { packetId?: string; flowId?: string } = {}): void {
    this.table('mac', op, mac, text, { iface, ...meta });
  }

  clearTable(): void {
    for (const e of this.macTable.values()) e.timer.cancelled = true;
    this.macTable.clear();
  }

  getState(): SwitchState {
    const now = this.engine.now;
    return {
      id: this.id,
      name: this.name,
      kind: 'switch',
      agingNs: this.agingNs,
      ports: portViews(this),
      mac: [...this.macTable.values()]
        .map((e) => ({ mac: e.mac, port: e.port, expiresIn: e.expiresAt - now }))
        .sort((a, b) => a.port.localeCompare(b.port, 'en', { numeric: true }) || a.mac.localeCompare(b.mac)),
    };
  }
}

export function portViews(d: Device) {
  return [...d.ports.values()].map((p) => {
    const v: SwitchState['ports'][number] = { id: p.id, mac: p.mac, mtu: p.mtu, queued: p.txQueue.length, busy: p.txBusy };
    if (p.ip) v.ip = `${p.ip.addr}/${p.ip.prefix}`;
    if (p.linkId) v.linkId = p.linkId;
    return v;
  });
}
