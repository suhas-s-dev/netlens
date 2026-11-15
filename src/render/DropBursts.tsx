/**
 * Voxel particle effects at devices:
 * - red explosion where a packet is dropped (TTL expired, no route, ...)
 * - small grey puff where a NIC discards a flooded frame that was not for it
 * - green sparkle fountain when a ping reply arrives
 */
import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { sim, useSim } from '../state/sim';
import { nodePos } from './layout';

const MAX = 900;
const LIFE_MS = 900;
const RED = new THREE.Color('#ff4d6d');
const ORANGE = new THREE.Color('#ffb020');
const GREY = new THREE.Color('#8a88a8');
const GREEN = new THREE.Color('#3ddc97');

/** Deterministic pseudo-random in [0,1) from two integers. */
function hash(a: number, b: number): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function DropBursts() {
  const topology = useSim((s) => s.topology);
  const positions = useMemo(() => new Map(topology.nodes.map((n) => [n.id, nodePos(n).setY(1.0)])), [topology]);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), s: new THREE.Vector3(), q: new THREE.Quaternion(), p: new THREE.Vector3(), c: new THREE.Color() }), []);

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    m.setColorAt(0, RED);
    m.count = 0;
  }, []);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const now = performance.now();
    let i = 0;
    const emit = (origin: THREE.Vector3, seed: number, n: number, age: number, kind: 'boom' | 'puff' | 'spark') => {
      for (let k = 0; k < n && i < MAX; k++) {
        const r1 = hash(seed, k * 3);
        const r2 = hash(seed, k * 3 + 1);
        const r3 = hash(seed, k * 3 + 2);
        const ang = r1 * Math.PI * 2;
        const t = age * (LIFE_MS / 1000);
        let speed: number, up: number, g: number, size: number, col: THREE.Color;
        if (kind === 'boom') [speed, up, g, size, col] = [2 + r2 * 3, 2 + r3 * 3, 9, 0.16 + r3 * 0.1, r2 > 0.6 ? ORANGE : RED];
        else if (kind === 'puff') [speed, up, g, size, col] = [0.6 + r2, 0.4 + r3, 1, 0.08, GREY];
        else [speed, up, g, size, col] = [0.5 + r2 * 0.8, 3 + r3 * 2.5, 4, 0.1 + r3 * 0.06, GREEN];
        tmp.p.set(origin.x + Math.cos(ang) * speed * t, origin.y + up * t - 0.5 * g * t * t, origin.z + Math.sin(ang) * speed * t);
        tmp.s.setScalar(size * (1 - age * 0.7));
        tmp.m.compose(tmp.p, tmp.q, tmp.s);
        m.setMatrixAt(i, tmp.m);
        m.setColorAt(i, tmp.c.copy(col).multiplyScalar(1 - age * 0.6));
        i++;
      }
    };
    for (let k = sim.drops.length - 1; k >= 0; k--) {
      const d = sim.drops[k]!;
      const age = (now - d.at) / LIFE_MS;
      if (age >= 1) break;
      const p = positions.get(d.node);
      if (p) emit(p, Math.floor(d.at), d.bystander ? 5 : 16, age, d.bystander ? 'puff' : 'boom');
    }
    for (let k = sim.sparks.length - 1; k >= 0; k--) {
      const d = sim.sparks[k]!;
      const age = (now - d.at) / LIFE_MS;
      if (age >= 1) break;
      const p = positions.get(d.node);
      if (p) emit(p, Math.floor(d.at) + 7, 14, age, 'spark');
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, MAX]} frustumCulled={false} raycast={() => null}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}
