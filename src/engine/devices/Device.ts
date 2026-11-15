import type { Engine } from '../core/Engine';
import type { Frame } from '../model/frame';
import type { NodeType } from '../model/topology';
import type { Ipv4, Mac } from '../protocols/addr';
import type { EthernetPayload } from '../protocols/types';
import type { DecisionEvent, DropEvent, DropReason, TableEvent, TableName, TableOp } from '../trace/events';
import type { DeviceState } from './state';

export interface PortIp {
  addr: Ipv4;
  prefix: number;
}

/** A device interface (NIC / switch port) plus its transmit queue. */
export interface Port {
  id: string;
  mac: Mac;
  ip?: PortIp;
  linkId?: string;
  /** Largest IP packet this port will send without fragmenting. */
  mtu: number;
  txQueue: Frame[];
  txBusy: boolean;
  /** Tail-drop limit for frames waiting behind the one being serialized. */
  maxQueue: number;
}

export interface PortInit {
  id: string;
  mac: Mac;
  ip?: PortIp;
  mtu?: number;
}

export interface SendMeta {
  flowId: string;
  parentId?: string;
}

export const DEFAULT_TX_QUEUE = 64;

export abstract class Device {
  abstract readonly kind: NodeType;
  readonly ports = new Map<string, Port>();

  constructor(
    readonly engine: Engine,
    readonly id: string,
    readonly name: string,
    ports: PortInit[],
  ) {
    for (const p of ports) {
      const port: Port = { id: p.id, mac: p.mac, mtu: p.mtu ?? 1500, txQueue: [], txBusy: false, maxQueue: DEFAULT_TX_QUEUE };
      if (p.ip) port.ip = p.ip;
      this.ports.set(p.id, port);
    }
  }

  /** Called by the engine when a frame has fully arrived on `port`. */
  abstract receive(port: Port, frame: Frame): void;

  abstract getState(): DeviceState;

  /** Display name for an interface in explanations ("port 2" on switches, "eth0" elsewhere). */
  portLabel(port: Port | string): string {
    return typeof port === 'string' ? port : port.id;
  }

  sendEth(port: Port, dst: Mac, etherType: number, payload: EthernetPayload, meta: SendMeta): Frame | undefined {
    return this.engine.transmit(this, port, { dst, src: port.mac, etherType, payload }, meta);
  }

  decision(action: DecisionEvent['action'], text: string, extra: Partial<Omit<DecisionEvent, 'type' | 'action' | 'text' | 'node'>> = {}): void {
    this.engine.emit({ type: 'decision', node: this.id, action, text, ...extra });
  }

  drop(reason: DropReason, text: string, extra: Partial<Omit<DropEvent, 'type' | 'reason' | 'text' | 'node'>> = {}): void {
    this.engine.emit({ type: 'drop', node: this.id, reason, text, ...extra });
  }

  table(table: TableName, op: TableOp, key: string, text: string, extra: Partial<Omit<TableEvent, 'type' | 'table' | 'op' | 'key' | 'text' | 'node'>> = {}): void {
    this.engine.emit({ type: 'table', node: this.id, table, op, key, text, ...extra });
  }

  /** Port that owns `ip`, if any. */
  portByIp(ip: Ipv4): Port | undefined {
    for (const p of this.ports.values()) if (p.ip?.addr === ip) return p;
    return undefined;
  }
}
