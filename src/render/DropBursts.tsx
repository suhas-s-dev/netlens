/** Expanding rings where frames are discarded: red for real drops, faint grey for a NIC
 * ignoring a frame that was not addressed to it (what flooding looks like to bystanders). */
import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { sim, useSim } from '../state/sim';
import { nodePos } from './layout';

const MAX = 128;
const LIFE_MS = 700;
const RED = new THREE.Color('#ff4d6d');
const GREY = new THREE.Color('#64748b');

export function DropBursts() {
  const topology = useSim((s) => s.topology);
  const positions = useMemo(() => new Map(topology.nodes.map((n) => [n.id, nodePos(n).setY(0.05)])), [topology]);
  const mesh = useRef<THREE.InstancedMesh>(null);
  const geo = useMemo(() => new THREE.RingGeometry(0.85, 1, 32).rotateX(-Math.PI / 2), []);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), s: new THREE.Vector3(), q: new THREE.Quaternion(), c: new THREE.Color() }), []);

  useLayoutEffect(() => {
    mesh.current?.setColorAt(0, RED);
    if (mesh.current) mesh.current.count = 0;
  }, []);

  useFrame(() => {
    const m = mesh.current;
    if (!m) return;
    const now = performance.now();
    let i = 0;
    for (let k = sim.drops.length - 1; k >= 0 && i < MAX; k--) {
      const d = sim.drops[k]!;
      const age = (now - d.at) / LIFE_MS;
      if (age >= 1) break;
      const p = positions.get(d.node);
      if (!p) continue;
      const r = 0.6 + age * 1.6;
      tmp.s.set(r, 1, r);
      tmp.m.compose(p, tmp.q, tmp.s);
      m.setMatrixAt(i, tmp.m);
      // Fade by darkening (additive blending: black = invisible).
      tmp.c.copy(d.bystander ? GREY : RED).multiplyScalar((1 - age) * (d.bystander ? 0.5 : 1));
      m.setColorAt(i, tmp.c);
      i++;
    }
    m.count = i;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[geo, undefined, MAX]} frustumCulled={false} raycast={() => null}>
      <meshBasicMaterial toneMapped={false} transparent blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
    </instancedMesh>
  );
}
