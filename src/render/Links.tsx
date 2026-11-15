import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import { sim, useSim } from '../state/sim';
import { linkGeometry, type LinkGeom } from './layout';

const UP = new THREE.Vector3(0, 1, 0);
const BASE = new THREE.Color('#3a4a5c');
const ACTIVE = new THREE.Color('#8fd3ff');

function Link({ g, register }: { g: LinkGeom; register: (id: string, m: THREE.MeshStandardMaterial | null) => void }) {
  const selected = useSim((s) => s.selection?.kind === 'link' && s.selection.id === g.id);
  const setSelection = useSim((s) => s.setSelection);
  const { mid, quat } = useMemo(() => {
    const dir = g.b.clone().sub(g.a).normalize();
    return { mid: g.a.clone().add(g.b).multiplyScalar(0.5), quat: new THREE.Quaternion().setFromUnitVectors(UP, dir) };
  }, [g]);
  return (
    <mesh
      position={mid}
      quaternion={quat}
      onClick={(e) => {
        e.stopPropagation();
        setSelection({ kind: 'link', id: g.id });
      }}
    >
      <cylinderGeometry args={[selected ? 0.09 : 0.06, selected ? 0.09 : 0.06, g.length, 8, 1, true]} />
      <meshStandardMaterial ref={(m) => register(g.id, m)} color={BASE} emissive={ACTIVE} emissiveIntensity={0} roughness={0.6} />
    </mesh>
  );
}

/** Links as tubes; brighten while frames are on them. */
export function Links() {
  const topology = useSim((s) => s.topology);
  const geoms = useMemo(() => linkGeometry(topology), [topology]);
  const mats = useRef(new Map<string, THREE.MeshStandardMaterial>());

  useFrame(() => {
    const busy = new Map<string, number>();
    for (const tx of sim.inFlight.values()) busy.set(tx.link, (busy.get(tx.link) ?? 0) + 1);
    const now = performance.now();
    for (const [id, m] of mats.current) {
      const n = busy.get(id) ?? 0;
      const recent = now - (sim.linkActivity.get(id) ?? -1e9) < 250 ? 0.4 : 0;
      const goal = Math.min(1.2, n * 0.45 + recent);
      m.emissiveIntensity = THREE.MathUtils.lerp(m.emissiveIntensity, goal, 0.15);
    }
  });

  const register = (id: string, m: THREE.MeshStandardMaterial | null) => {
    if (m) mats.current.set(id, m);
    else mats.current.delete(id);
  };
  return (
    <group>
      {[...geoms.values()].map((g) => (
        <Link key={g.id} g={g} register={register} />
      ))}
    </group>
  );
}
