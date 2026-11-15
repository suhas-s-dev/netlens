/** Scene geometry helpers shared by meshes, links and packets. */
import * as THREE from 'three';
import type { NodeJson, NodeType, TopologyJson } from '../engine';

/** Visual footprint radius by device type (where link tubes attach). */
export const DEVICE_RADIUS: Record<NodeType, number> = { host: 0.95, switch: 1.35, router: 1.1 };
export const LINK_HEIGHT = 0.45;

export function nodePos(n: Pick<NodeJson, 'position'>): THREE.Vector3 {
  return new THREE.Vector3(n.position.x, 0, n.position.y);
}

export interface LinkGeom {
  id: string;
  a: THREE.Vector3;
  b: THREE.Vector3;
  aNode: string;
  bNode: string;
  aIface: string;
  bIface: string;
  length: number;
}

/** Link endpoints: on each device's rim, facing the peer. */
export function linkGeometry(topo: TopologyJson): Map<string, LinkGeom> {
  const byId = new Map(topo.nodes.map((n) => [n.id, n]));
  const out = new Map<string, LinkGeom>();
  for (const l of topo.links) {
    const na = byId.get(l.a.node);
    const nb = byId.get(l.b.node);
    if (!na || !nb) continue;
    const pa = nodePos(na);
    const pb = nodePos(nb);
    const dir = pb.clone().sub(pa);
    const len = dir.length() || 1;
    dir.divideScalar(len);
    const a = pa.clone().addScaledVector(dir, Math.min(DEVICE_RADIUS[na.type], len * 0.3)).setY(LINK_HEIGHT);
    const b = pb.clone().addScaledVector(dir, -Math.min(DEVICE_RADIUS[nb.type], len * 0.3)).setY(LINK_HEIGHT);
    out.set(l.id, { id: l.id, a, b, aNode: l.a.node, bNode: l.b.node, aIface: l.a.iface, bIface: l.b.iface, length: a.distanceTo(b) });
  }
  return out;
}

/** Port anchor position for (node, iface), if linked. */
export function portAnchors(links: Map<string, LinkGeom>): Map<string, THREE.Vector3> {
  const m = new Map<string, THREE.Vector3>();
  for (const g of links.values()) {
    m.set(`${g.aNode}.${g.aIface}`, g.a);
    m.set(`${g.bNode}.${g.bIface}`, g.b);
  }
  return m;
}

/** Where the camera is looking (on the ground plane); written by the camera rig each frame. */
export const viewCenter = { x: 0, y: 0 };

/** Editor: positions for interfaces that are not linked yet, in a row in front of the device. */
export function freePortPositions(topo: TopologyJson): Map<string, THREE.Vector3> {
  const linked = new Set(topo.links.flatMap((l) => [`${l.a.node}.${l.a.iface}`, `${l.b.node}.${l.b.iface}`]));
  const out = new Map<string, THREE.Vector3>();
  for (const n of topo.nodes) {
    const free = n.interfaces.filter((i) => !linked.has(`${n.id}.${i.id}`));
    const gap = 0.85;
    free.forEach((i, k) => {
      const x = (k - (free.length - 1) / 2) * gap;
      out.set(`${n.id}.${i.id}`, nodePos(n).add(new THREE.Vector3(x, 0.3, DEVICE_RADIUS[n.type] + 0.45)));
    });
  }
  return out;
}
