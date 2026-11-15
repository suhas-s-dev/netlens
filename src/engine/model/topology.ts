/** Serializable topology description: what presets, the editor, localStorage and JSON
 * export all use. The engine is built from this; it never mutates it. */

export type NodeType = 'host' | 'switch' | 'router';

export interface Vec2 {
  x: number;
  y: number;
}

export interface InterfaceJson {
  id: string; // "eth0" on hosts/routers, "1".."N" on switches
  /** Optional fixed MAC; generated deterministically when omitted. */
  mac?: string;
  /** "10.0.0.10/24"; ignored on switches. */
  ip?: string;
}

interface NodeBase {
  id: string;
  name: string;
  position: Vec2;
  interfaces: InterfaceJson[];
}

export interface HostJson extends NodeBase {
  type: 'host';
  gateway?: string;
}

export interface SwitchJson extends NodeBase {
  type: 'switch';
}

export interface StaticRouteJson {
  prefix: string; // "10.0.3.0/24"
  nextHop: string; // "10.0.23.2"
}

export interface RouterJson extends NodeBase {
  type: 'router';
  staticRoutes: StaticRouteJson[];
}

export type NodeJson = HostJson | SwitchJson | RouterJson;

export interface LinkEndJson {
  node: string;
  iface: string;
}

export interface LinkJson {
  id: string;
  a: LinkEndJson;
  b: LinkEndJson;
  /** One-way propagation delay. */
  latencyMs?: number;
  bandwidthMbps?: number;
}

/** Scripted actions for presets (sim time in ms from start). */
export type ScenarioStep =
  | { at: number; action: 'ping'; node: string; dst: string; count?: number; intervalMs?: number; ttl?: number }
  | { at: number; action: 'traceroute'; node: string; dst: string; maxHops?: number };

export interface TopologyJson {
  version: 1;
  name: string;
  description?: string;
  seed?: number;
  nodes: NodeJson[];
  links: LinkJson[];
  scenario?: ScenarioStep[];
}

export const DEFAULT_LINK_LATENCY_MS = 2;
export const DEFAULT_LINK_BANDWIDTH_MBPS = 10;
