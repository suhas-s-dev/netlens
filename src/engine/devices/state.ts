/** Plain read-only snapshots of device state for the UI (device panels, inspector). */
import type { NodeType } from '../model/topology';

export interface PortView {
  id: string;
  mac: string;
  ip?: string; // CIDR
  linkId?: string;
  mtu: number;
  queued: number;
  busy: boolean;
}

export interface ArpRow {
  iface: string;
  ip: string;
  mac: string | null; // null while incomplete
  state: 'reachable' | 'incomplete';
  /** ns until the entry ages out (reachable) or the next retry (incomplete). */
  expiresIn: number;
  queued: number;
}

export interface MacRow {
  mac: string;
  port: string;
  expiresIn: number;
}

export interface RouteRow {
  prefix: string; // CIDR
  nextHop: string | null;
  iface: string;
  type: 'connected' | 'static';
  active: boolean;
}

export interface AppSessionView {
  id: string;
  app: 'ping' | 'traceroute' | 'pmtud' | 'mtr';
  dst: string;
  done: boolean;
  lines: string[];
}

interface Base {
  id: string;
  name: string;
  kind: NodeType;
  ports: PortView[];
}

export interface PmtuRow {
  dst: string;
  mtu: number;
  expiresIn: number;
}

export interface HostState extends Base {
  kind: 'host';
  gateway: string | null;
  arp: ArpRow[];
  pmtu: PmtuRow[];
  sessions: AppSessionView[];
}

export interface SwitchState extends Base {
  kind: 'switch';
  mac: MacRow[];
  agingNs: number;
}

export interface RouterState extends Base {
  kind: 'router';
  routes: RouteRow[];
  arp: ArpRow[];
}

export type DeviceState = HostState | SwitchState | RouterState;
