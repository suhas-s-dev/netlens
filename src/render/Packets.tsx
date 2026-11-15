/**
 * All in-flight frames as two InstancedMeshes (core + additive halo). Positions come from
 * sim time and the engine's exact tx timing:
 *   head = (t - txStart) / propagation, tail = (t - txEnd) / propagation
 * so a frame's visible length is its serialization time: bigger frames are longer streaks.
 */
import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { PacketClass } from '../engine';
import { sim, useSim } from '../state/sim';
import { PACKET_COLORS } from './colors';
import { linkGeometry } from './layout';

const MAX = 4096;
const MIN_LEN = 0.38;
const X = new THREE.Vector3(1, 0, 0);
const COLORS = Object.fromEntries(Object.entries(PACKET_COLORS).map(([k, v]) => [k, new THREE.Color(v)])) as Record<PacketClass, THREE.Color>;
const WHITE = new THREE.Color('#ffffff');

export function Packets() {
  const topology = useSim((s) => s.topology);
  const geoms = useMemo(() => linkGeometry(topology), [topology]);
  const core = useRef<THREE.InstancedMesh>(null);
  const halo = useRef<THREE.InstancedMesh>(null);
  const ids = useRef<string[]>([]);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(), d: new THREE.Vector3(), c: new THREE.Color() }), []);

  const coreGeo = useMemo(() => new THREE.CapsuleGeometry(0.13, 1, 3, 8).rotateZ(Math.PI / 2), []);
  const haloGeo = useMemo(() => new THREE.SphereGeometry(0.5, 10, 8), []);

  // Allocate per-instance colour buffers up front so the shader is compiled with them.
  useLayoutEffect(() => {
    for (const m of [core.current, halo.current]) {
      if (!m) continue;
      m.setColorAt(0, WHITE);
      m.count = 0;
    }
  }, []);

  useFrame(() => {
    const c = core.current;
    const h = halo.current;
    if (!c || !h) return;
    const t = sim.engine.now;
    const sel = useSim.getState().selection;
    const selected = sel?.kind === 'packet' ? sel.id : null;
    let i = 0;
    const list = ids.current;
    list.length = 0;
    for (const tx of sim.inFlight.values()) {
      if (i >= MAX) break;
      const g = geoms.get(tx.link);
      if (!g) continue;
      const forward = tx.node === g.aNode && tx.iface === g.aIface;
      const from = forward ? g.a : g.b;
      const to = forward ? g.b : g.a;
      const prop = Math.max(1, tx.arrive - tx.txEnd);
      const head = THREE.MathUtils.clamp((t - tx.txStart) / prop, 0, 1);
      const tail = THREE.MathUtils.clamp((t - tx.txEnd) / prop, 0, 1);
      const L = g.length;
      const len = Math.max(MIN_LEN, (head - tail) * L);
      // centre of the visible streak, kept inside the link
      let centre = ((head + tail) / 2) * L;
      centre = THREE.MathUtils.clamp(centre, Math.min(len / 2, L / 2), Math.max(L - len / 2, L / 2));
      tmp.d.subVectors(to, from).normalize();
      tmp.p.copy(from).addScaledVector(tmp.d, centre);
      tmp.q.setFromUnitVectors(X, tmp.d);
      const isSel = tx.packetId === selected;
      const k = isSel ? 1.7 : 1;
      tmp.s.set(len / 1.26, k, k);
      tmp.m.compose(tmp.p, tmp.q, tmp.s);
      c.setMatrixAt(i, tmp.m);
      tmp.s.set(Math.max(0.9, len * 0.9), 0.75 * k, 0.75 * k);
      tmp.m.compose(tmp.p, tmp.q, tmp.s);
      h.setMatrixAt(i, tmp.m);
      const col = COLORS[tx.cls];
      c.setColorAt(i, isSel ? tmp.c.copy(col).lerp(WHITE, 0.55) : col);
      h.setColorAt(i, col);
      list.push(tx.packetId!);
      i++;
    }
    c.count = i;
    h.count = i;
    c.instanceMatrix.needsUpdate = true;
    h.instanceMatrix.needsUpdate = true;
    if (c.instanceColor) c.instanceColor.needsUpdate = true;
    if (h.instanceColor) h.instanceColor.needsUpdate = true;
    // Instances move every frame: drop the cached bounds so raycasting recomputes them.
    c.boundingSphere = null;
  });

  return (
    <group>
      <instancedMesh
        ref={core}
        args={[coreGeo, undefined, MAX]}
        frustumCulled={false}
        onClick={(e) => {
          e.stopPropagation();
          const id = e.instanceId !== undefined ? ids.current[e.instanceId] : undefined;
          if (id) {
            sim.pause();
            useSim.getState().setSelection({ kind: 'packet', id });
          }
        }}
        onPointerMove={(e) => {
          const id = e.instanceId !== undefined ? ids.current[e.instanceId] : undefined;
          const cur = useSim.getState().hover;
          if (!id) return;
          if (cur?.id !== id || Math.abs(cur.x - e.nativeEvent.clientX) + Math.abs(cur.y - e.nativeEvent.clientY) > 6)
            useSim.getState().set('hover', { id, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
        }}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => {
          document.body.style.cursor = '';
          useSim.getState().set('hover', null);
        }}
      >
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
      <instancedMesh ref={halo} args={[haloGeo, undefined, MAX]} frustumCulled={false} raycast={() => null}>
        <meshBasicMaterial toneMapped={false} transparent opacity={0.22} blending={THREE.AdditiveBlending} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}
