/** Static topology validation for the editor (and a sanity check for presets). */
import type { NodeJson, TopologyJson } from '../model/topology';
import { broadcastOf, inSubnet, isValidIp, isValidMac, networkOf, parseCidr, subnetsOverlap } from '../protocols/addr';
import { generatedMac } from './build';

export interface ValidationIssue {
  level: 'error' | 'warning';
  message: string;
  node?: string;
  iface?: string;
  link?: string;
}

interface Addressed {
  node: NodeJson;
  iface: string;
  ip: string;
  prefix: number;
  network: string;
}

function tryCidr(s: string): { ip: string; prefix: number } | null {
  try {
    return parseCidr(s);
  } catch {
    return null;
  }
}

/** L2 broadcast domains: switch ports are bridged together, links join their two ends. */
export function segmentsOf(topo: TopologyJson): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const n of topo.nodes) for (const i of n.interfaces) parent.set(`${n.id}.${i.id}`, `${n.id}.${i.id}`);
  for (const n of topo.nodes) {
    if (n.type !== 'switch') continue;
    const [first, ...rest] = n.interfaces;
    if (first) for (const i of rest) union(`${n.id}.${first.id}`, `${n.id}.${i.id}`);
  }
  for (const l of topo.links) {
    const a = `${l.a.node}.${l.a.iface}`;
    const b = `${l.b.node}.${l.b.iface}`;
    if (parent.has(a) && parent.has(b)) union(a, b);
  }
  const out = new Map<string, string>();
  for (const k of parent.keys()) out.set(k, find(k));
  return out;
}

export function validateTopology(topo: TopologyJson): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const err = (message: string, at: Omit<ValidationIssue, 'level' | 'message'> = {}) => issues.push({ level: 'error', message, ...at });
  const warn = (message: string, at: Omit<ValidationIssue, 'level' | 'message'> = {}) => issues.push({ level: 'warning', message, ...at });

  // --- nodes & interfaces
  const ids = new Set<string>();
  const names = new Set<string>();
  const macs = new Map<string, string>();
  const addressed: Addressed[] = [];
  topo.nodes.forEach((n, idx) => {
    if (ids.has(n.id)) err(`Duplicate node id "${n.id}"`, { node: n.id });
    ids.add(n.id);
    if (names.has(n.name)) warn(`Duplicate device name "${n.name}"`, { node: n.id });
    names.add(n.name);
    const ifaceIds = new Set<string>();
    n.interfaces.forEach((i, k) => {
      if (ifaceIds.has(i.id)) err(`${n.name}: duplicate interface "${i.id}"`, { node: n.id, iface: i.id });
      ifaceIds.add(i.id);
      const mac = (i.mac ?? generatedMac(idx, k)).toLowerCase();
      if (!isValidMac(mac)) err(`${n.name} ${i.id}: invalid MAC "${i.mac}"`, { node: n.id, iface: i.id });
      else if (macs.has(mac)) err(`${n.name} ${i.id}: MAC ${mac} already used by ${macs.get(mac)}`, { node: n.id, iface: i.id });
      else macs.set(mac, `${n.name} ${i.id}`);
      if (n.type === 'switch' || !i.ip) return;
      const c = tryCidr(i.ip);
      if (!c) {
        err(`${n.name} ${i.id}: "${i.ip}" is not a valid address/prefix (e.g. 10.0.0.1/24)`, { node: n.id, iface: i.id });
        return;
      }
      if (c.prefix > 30 && c.prefix !== 31) {
        err(`${n.name} ${i.id}: /${c.prefix} leaves no room for another host`, { node: n.id, iface: i.id });
      } else if (c.prefix <= 30 && (c.ip === networkOf(c.ip, c.prefix) || c.ip === broadcastOf(c.ip, c.prefix))) {
        err(`${n.name} ${i.id}: ${c.ip} is the ${c.ip === networkOf(c.ip, c.prefix) ? 'network' : 'broadcast'} address of ${networkOf(c.ip, c.prefix)}/${c.prefix}`, { node: n.id, iface: i.id });
      }
      addressed.push({ node: n, iface: i.id, ip: c.ip, prefix: c.prefix, network: networkOf(c.ip, c.prefix) });
    });
    if (n.type === 'host') {
      const own = addressed.filter((a) => a.node === n);
      if (!own.length) warn(`${n.name} has no IP address`, { node: n.id });
      if (n.gateway) {
        if (!isValidIp(n.gateway)) err(`${n.name}: gateway "${n.gateway}" is not a valid IPv4 address`, { node: n.id });
        else if (own[0] && !inSubnet(n.gateway, own[0].network, own[0].prefix)) err(`${n.name}: gateway ${n.gateway} is outside its subnet ${own[0].network}/${own[0].prefix}`, { node: n.id });
        else if (own[0] && n.gateway === own[0].ip) err(`${n.name}: gateway is its own address`, { node: n.id });
      }
    }
  });

  // --- duplicate IPs
  const byIp = new Map<string, Addressed>();
  for (const a of addressed) {
    const prev = byIp.get(a.ip);
    if (prev) err(`Duplicate IP ${a.ip}: ${prev.node.name} ${prev.iface} and ${a.node.name} ${a.iface}`, { node: a.node.id, iface: a.iface });
    else byIp.set(a.ip, a);
  }

  // --- links
  const used = new Map<string, string>();
  for (const l of topo.links) {
    for (const end of [l.a, l.b]) {
      const n = topo.nodes.find((x) => x.id === end.node);
      if (!n || !n.interfaces.some((i) => i.id === end.iface)) {
        err(`Link ${l.id}: endpoint ${end.node}.${end.iface} does not exist`, { link: l.id });
        continue;
      }
      const k = `${end.node}.${end.iface}`;
      if (used.has(k)) err(`${n.name} ${end.iface} is connected twice (links ${used.get(k)} and ${l.id})`, { link: l.id, node: n.id, iface: end.iface });
      used.set(k, l.id);
    }
    if (l.a.node === l.b.node) err(`Link ${l.id} connects ${l.a.node} to itself`, { link: l.id });
    if ((l.latencyMs ?? 1) < 0) err(`Link ${l.id}: latency must be ≥ 0`, { link: l.id });
    if ((l.bandwidthMbps ?? 1) <= 0) err(`Link ${l.id}: bandwidth must be > 0`, { link: l.id });
  }

  // --- subnets: per router, and across L2 segments
  const seg = segmentsOf(topo);
  for (const n of topo.nodes) {
    if (n.type !== 'router') continue;
    const own = addressed.filter((a) => a.node === n);
    for (let i = 0; i < own.length; i++)
      for (let j = i + 1; j < own.length; j++) {
        const a = own[i]!;
        const b = own[j]!;
        if (subnetsOverlap(a.network, a.prefix, b.network, b.prefix))
          err(`${n.name}: ${a.iface} (${a.network}/${a.prefix}) and ${b.iface} (${b.network}/${b.prefix}) overlap`, { node: n.id, iface: b.iface });
      }
    for (const r of n.staticRoutes) {
      const c = tryCidr(r.prefix);
      if (!c) err(`${n.name}: static route prefix "${r.prefix}" is invalid`, { node: n.id });
      else if (networkOf(c.ip, c.prefix) !== c.ip) warn(`${n.name}: route ${r.prefix} has host bits set (treated as ${networkOf(c.ip, c.prefix)}/${c.prefix})`, { node: n.id });
      if (!isValidIp(r.nextHop)) err(`${n.name}: next hop "${r.nextHop}" is invalid`, { node: n.id });
      else if (!own.some((a) => inSubnet(r.nextHop, a.network, a.prefix))) err(`${n.name}: next hop ${r.nextHop} for ${r.prefix} is not on any connected subnet`, { node: n.id });
      else if (own.some((a) => a.ip === r.nextHop)) err(`${n.name}: next hop ${r.nextHop} is the router's own address`, { node: n.id });
    }
  }
  const segNets = new Map<string, Addressed[]>();
  for (const a of addressed) {
    const s = seg.get(`${a.node.id}.${a.iface}`)!;
    segNets.set(s, [...(segNets.get(s) ?? []), a]);
  }
  const segs = [...segNets.entries()];
  for (const [, list] of segs) {
    const first = list[0]!;
    for (const a of list.slice(1)) {
      if (a.network !== first.network || a.prefix !== first.prefix) {
        warn(`${a.node.name} ${a.iface} (${a.network}/${a.prefix}) is on the same LAN as ${first.node.name} (${first.network}/${first.prefix}) but in a different subnet`, { node: a.node.id, iface: a.iface });
      }
    }
  }
  for (let i = 0; i < segs.length; i++)
    for (let j = i + 1; j < segs.length; j++) {
      const a = segs[i]![1][0]!;
      const b = segs[j]![1][0]!;
      if (subnetsOverlap(a.network, a.prefix, b.network, b.prefix))
        err(`Subnet ${a.network}/${a.prefix} (${a.node.name}) overlaps ${b.network}/${b.prefix} (${b.node.name}) on a different LAN`, { node: b.node.id, iface: b.iface });
    }

  // --- gateways reachable on the LAN
  for (const n of topo.nodes) {
    if (n.type !== 'host' || !n.gateway) continue;
    const mine = addressed.find((a) => a.node === n);
    const gw = byIp.get(n.gateway);
    if (mine && gw && seg.get(`${gw.node.id}.${gw.iface}`) !== seg.get(`${n.id}.${mine.iface}`))
      warn(`${n.name}: gateway ${n.gateway} (${gw.node.name}) is not on the same LAN`, { node: n.id });
    else if (mine && !gw && inSubnet(n.gateway, mine.network, mine.prefix)) warn(`${n.name}: no device has gateway address ${n.gateway}`, { node: n.id });
  }

  return issues;
}
