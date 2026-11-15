/** Structured trace events. Every engine decision emits one, with a human-readable `text`.
 * They drive the event log, the renderer (tx events carry exact timing) and the tests. */
import type { Frame } from '../model/frame';
import type { PacketClass } from '../protocols/describe';

export interface TraceBase {
  /** Monotonic per engine. */
  seq: number;
  /** Sim time (ns). */
  time: number;
  node?: string;
  text: string;
  packetId?: string;
  flowId?: string;
}

/** A frame started serializing onto a link. */
export interface TxEvent extends TraceBase {
  type: 'tx';
  node: string;
  iface: string;
  link: string;
  toNode: string;
  toIface: string;
  frame: Frame;
  cls: PacketClass;
  /** Frame length as captured (no preamble/FCS). */
  size: number;
  /** Bytes on the wire incl. preamble, FCS and inter-frame gap. */
  wireSize: number;
  txStart: number;
  txEnd: number;
  arrive: number;
}

export interface RxEvent extends TraceBase {
  type: 'rx';
  node: string;
  iface: string;
  link: string;
  frame: Frame;
}

export type DropReason =
  | 'not-for-me'
  | 'no-link'
  | 'queue-full'
  | 'bad-checksum'
  | 'ttl-expired'
  | 'no-route'
  | 'arp-failed'
  | 'filtered'
  | 'broadcast-not-forwarded'
  | 'no-gateway'
  | 'too-big'
  | 'reassembly-timeout'
  | 'link-loss'
  | 'port-closed'
  | 'unsupported';

export interface DropEvent extends TraceBase {
  type: 'drop';
  node: string;
  reason: DropReason;
  iface?: string;
}

export type TableName = 'arp' | 'mac' | 'route' | 'pmtu' | 'tcp';
export type TableOp = 'add' | 'update' | 'refresh' | 'hit' | 'remove' | 'pending';

export interface TableEvent extends TraceBase {
  type: 'table';
  node: string;
  table: TableName;
  op: TableOp;
  /** Row key: IP for ARP (per iface), MAC for switch table, prefix for routes. */
  key: string;
  iface?: string;
}

/** A forwarding/routing decision (flood, forward, LPM match, TTL decrement, ...). */
export interface DecisionEvent extends TraceBase {
  type: 'decision';
  node: string;
  action: 'flood' | 'forward' | 'lpm' | 'ttl' | 'local' | 'nexthop' | 'reply' | 'icmp-error' | 'queue' | 'fragment' | 'reassemble' | 'tcp' | 'udp';
  /** Egress interfaces involved, if any. */
  ifaces?: string[];
}

/** Application-level output (ping/traceroute lines). */
export interface AppEvent extends TraceBase {
  type: 'app';
  node: string;
  app: 'ping' | 'traceroute' | 'pmtud' | 'mtr' | 'tcp' | 'udp';
  sessionId: string;
  status: 'start' | 'sent' | 'reply' | 'timeout' | 'error' | 'hop' | 'done';
}

export type TraceEvent = TxEvent | RxEvent | DropEvent | TableEvent | DecisionEvent | AppEvent;
export type TraceType = TraceEvent['type'];

/** What callers pass to `emit` (seq/time are filled in by the engine). */
export type TraceInput =
  | Omit<TxEvent, 'seq' | 'time'>
  | Omit<RxEvent, 'seq' | 'time'>
  | Omit<DropEvent, 'seq' | 'time'>
  | Omit<TableEvent, 'seq' | 'time'>
  | Omit<DecisionEvent, 'seq' | 'time'>
  | Omit<AppEvent, 'seq' | 'time'>;
