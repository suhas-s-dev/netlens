/** Pure, immutable topology edit operations used by the editor. */
import { generatedMac, type InterfaceJson, type LinkEndJson, type LinkJson, type NodeJson, type NodeType, type TopologyJson, type Vec2 } from '../engine';

const PREFIX: Record<NodeType, { id: string; name: string }> = {
  host: { id: 'h', name: 'H' },
  switch: { id: 'sw', name: 'SW' },
  router: { id: 'r', name: 'R' },
};

/** Give every interface an explicit MAC so deleting nodes never renumbers the rest. */
export function materializeMacs(t: TopologyJson): TopologyJson {
  if (t.nodes.every((n) => n.interfaces.every((i) => i.mac))) return t;
  return {
    ...t,
    nodes: t.nodes.map((n, idx) => ({ ...n, interfaces: n.interfaces.map((i, k) => (i.mac ? i : { ...i, mac: generatedMac(idx, k) })) })) as NodeJson[],
  };
}

function usedMacs(t: TopologyJson): Set<string> {
  return new Set(t.nodes.flatMap((n, idx) => n.interfaces.map((i, k) => (i.mac ?? generatedMac(idx, k)).toLowerCase())));
}

/** A fresh MAC in the same locally-administered 02:00:00:NN:NN:II space. */
export function freshMac(t: TopologyJson, ifaceIndex: number, used = usedMacs(t)): string {
  for (let n = t.nodes.length; ; n++) {
    const mac = generatedMac(n, ifaceIndex);
    if (!used.has(mac)) return mac;
  }
}

function nextSerial(t: TopologyJson, type: NodeType): number {
  const p = PREFIX[type];
  let max = 0;
  for (const n of t.nodes) {
    const m = new RegExp(`^${p.id}(\\d+)$`).exec(n.id) ?? new RegExp(`^${p.name}(\\d+)$`).exec(n.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function uniqueLinkId(t: TopologyJson): string {
  const ids = new Set(t.links.map((l) => l.id));
  for (let i = t.links.length + 1; ; i++) if (!ids.has(`l${i}`)) return `l${i}`;
}

export function addNode(t: TopologyJson, type: NodeType, position: Vec2): { topology: TopologyJson; id: string } {
  const serial = nextSerial(t, type);
  const id = `${PREFIX[type].id}${serial}`;
  const name = `${PREFIX[type].name}${serial}`;
  const used = usedMacs(t);
  const ifaceIds = type === 'host' ? ['eth0'] : type === 'router' ? ['eth0', 'eth1'] : ['1', '2', '3', '4'];
  const interfaces: InterfaceJson[] = ifaceIds.map((iid, k) => {
    const mac = freshMac(t, k, used);
    used.add(mac);
    return { id: iid, mac };
  });
  let node: NodeJson;
  if (type === 'host') node = { id, name, type, position, interfaces };
  else if (type === 'router') node = { id, name, type, position, interfaces, staticRoutes: [] };
  else node = { id, name, type, position, interfaces };
  return { topology: { ...t, nodes: [...t.nodes, node] }, id };
}

export function removeNode(t: TopologyJson, id: string): TopologyJson {
  return {
    ...t,
    nodes: t.nodes.filter((n) => n.id !== id),
    links: t.links.filter((l) => l.a.node !== id && l.b.node !== id),
    scenario: t.scenario?.filter((s) => s.node !== id),
  };
}

export function moveNode(t: TopologyJson, id: string, position: Vec2): TopologyJson {
  return { ...t, nodes: t.nodes.map((n) => (n.id === id ? { ...n, position } : n)) };
}

export function updateNode(t: TopologyJson, id: string, fn: (n: NodeJson) => NodeJson): TopologyJson {
  return { ...t, nodes: t.nodes.map((n) => (n.id === id ? fn(n) : n)) };
}

export function isLinked(t: TopologyJson, end: LinkEndJson): boolean {
  return t.links.some((l) => (l.a.node === end.node && l.a.iface === end.iface) || (l.b.node === end.node && l.b.iface === end.iface));
}

/** Connect two interfaces. Returns an error message instead when it is not allowed. */
export function connect(t: TopologyJson, a: LinkEndJson, b: LinkEndJson): TopologyJson | string {
  if (a.node === b.node) return 'Cannot link a device to itself';
  for (const end of [a, b]) {
    const n = t.nodes.find((x) => x.id === end.node);
    if (!n?.interfaces.some((i) => i.id === end.iface)) return `${end.node}.${end.iface} does not exist`;
    if (isLinked(t, end)) return `${n.name} ${end.iface} is already connected`;
  }
  const link: LinkJson = { id: uniqueLinkId(t), a, b };
  return { ...t, links: [...t.links, link] };
}

export function removeLink(t: TopologyJson, id: string): TopologyJson {
  return { ...t, links: t.links.filter((l) => l.id !== id) };
}

export function updateLink(t: TopologyJson, id: string, patch: Partial<Pick<LinkJson, 'latencyMs' | 'bandwidthMbps'>>): TopologyJson {
  return { ...t, links: t.links.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

export function addInterface(t: TopologyJson, nodeId: string): TopologyJson {
  const n = t.nodes.find((x) => x.id === nodeId);
  if (!n || n.type === 'host') return t;
  const ids = new Set(n.interfaces.map((i) => i.id));
  let iid = '';
  for (let k = 0; ; k++) {
    iid = n.type === 'switch' ? String(k + 1) : `eth${k}`;
    if (!ids.has(iid)) break;
  }
  const mac = freshMac(t, n.interfaces.length);
  return updateNode(t, nodeId, (x) => ({ ...x, interfaces: [...x.interfaces, { id: iid, mac }] }) as NodeJson);
}

export function removeInterface(t: TopologyJson, nodeId: string, ifaceId: string): TopologyJson {
  const t2 = { ...t, links: t.links.filter((l) => !((l.a.node === nodeId && l.a.iface === ifaceId) || (l.b.node === nodeId && l.b.iface === ifaceId))) };
  return updateNode(t2, nodeId, (x) => ({ ...x, interfaces: x.interfaces.filter((i) => i.id !== ifaceId) }) as NodeJson);
}

export function setInterfaceIp(t: TopologyJson, nodeId: string, ifaceId: string, ip: string): TopologyJson {
  return updateNode(t, nodeId, (x) => ({ ...x, interfaces: x.interfaces.map((i) => (i.id === ifaceId ? (ip ? { ...i, ip } : { id: i.id, ...(i.mac ? { mac: i.mac } : {}) }) : i)) }) as NodeJson);
}

/** Nearest free spot (≥ 3.5 units from other devices) to `near`, on a 0.5 grid. */
export function freeSpot(t: TopologyJson, near: Vec2): Vec2 {
  const snap = (v: number) => Math.round(v * 2) / 2;
  const ok = (p: Vec2) => t.nodes.every((n) => Math.hypot(n.position.x - p.x, n.position.y - p.y) >= 3.5);
  for (let r = 0; r < 40; r += 1.5) {
    const steps = Math.max(1, Math.round(r * 2));
    for (let s = 0; s < steps; s++) {
      const a = (s / steps) * Math.PI * 2;
      const p = { x: snap(near.x + Math.cos(a) * r), y: snap(near.y + Math.sin(a) * r) };
      if (ok(p)) return p;
    }
  }
  return { x: snap(near.x), y: snap(near.y) };
}

export function emptyTopology(): TopologyJson {
  return { version: 1, name: 'Untitled network', nodes: [], links: [] };
}
