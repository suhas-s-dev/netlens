/** Floating "islands": one tiled platform per LAN (broadcast domain), a small pad per router. */
import { networkOf, parseCidr, segmentsOf, type NodeJson, type TopologyJson } from '../engine';

export interface Island {
  id: string;
  kind: 'lan' | 'router';
  /** Centre and size on the ground plane (x, z). */
  cx: number;
  cz: number;
  w: number;
  d: number;
  label: string;
  nodes: string[];
}

const PAD = 2.2;

export function computeIslands(topo: TopologyJson): Island[] {
  const seg = segmentsOf(topo);
  const byId = new Map(topo.nodes.map((n) => [n.id, n]));
  const groups = new Map<string, Set<string>>();
  const nets = new Map<string, string>();
  for (const n of topo.nodes) {
    if (n.type === 'router') continue;
    for (const i of n.interfaces) {
      const root = seg.get(`${n.id}.${i.id}`);
      if (!root) continue;
      if (!groups.has(root)) groups.set(root, new Set());
      groups.get(root)!.add(n.id);
      if (i.ip && !nets.has(root)) {
        try {
          const c = parseCidr(i.ip);
          nets.set(root, `${networkOf(c.ip, c.prefix)}/${c.prefix}`);
        } catch {
          /* invalid while editing */
        }
      }
    }
  }
  // A switch's ports are all one segment, but a host-only LAN (no switch) is too: merge
  // groups that share a node.
  const merged: Set<string>[] = [];
  const keyOf = new Map<Set<string>, string>();
  for (const [root, g] of groups) {
    const hit = merged.find((m) => [...g].some((x) => m.has(x)));
    if (hit) for (const x of g) hit.add(x);
    else {
      merged.push(g);
      keyOf.set(g, root);
    }
  }
  const out: Island[] = [];
  merged.forEach((g, k) => {
    const nodes = [...g].map((id) => byId.get(id)!).filter(Boolean) as NodeJson[];
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.position.x);
    const zs = nodes.map((n) => n.position.y);
    const minX = Math.min(...xs) - PAD;
    const maxX = Math.max(...xs) + PAD;
    const minZ = Math.min(...zs) - PAD;
    const maxZ = Math.max(...zs) + PAD;
    const net = nets.get(keyOf.get(g) ?? '');
    out.push({ id: `lan${k}`, kind: 'lan', cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ, label: net ? `LAN ${net}` : 'LAN', nodes: [...g] });
  });
  for (const n of topo.nodes) {
    if (n.type !== 'router') continue;
    out.push({ id: `pad-${n.id}`, kind: 'router', cx: n.position.x, cz: n.position.y, w: 3.4, d: 3.4, label: '', nodes: [n.id] });
  }
  return out;
}
