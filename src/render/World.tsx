/** The diorama: gradient sky, floating LAN islands, drifting voxel dust, pixel-art post-processing. */
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPixelatedPass } from 'three/examples/jsm/postprocessing/RenderPixelatedPass.js';
import { useSim } from '../state/sim';
import { computeIslands, type Island } from './islands';

export function Sky() {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { top: { value: new THREE.Color('#2a1b5c') }, mid: { value: new THREE.Color('#14103a') }, bottom: { value: new THREE.Color('#07060f') } },
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.8, h)) : mix(mid, bottom, smoothstep(0.0, 0.5, -h)); gl_FragColor = vec4(c, 1.0); }',
      }),
    [],
  );
  return (
    <mesh material={mat} scale={300} raycast={() => null} renderOrder={-1}>
      <sphereGeometry args={[1, 24, 12]} />
    </mesh>
  );
}

/** Nearest-filtered checker texture for island tops. */
function tileTexture(a: string, b: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d')!;
  g.fillStyle = a;
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = b;
  g.fillRect(0, 0, 8, 8);
  g.fillRect(8, 8, 8, 8);
  g.fillStyle = 'rgba(255,255,255,0.06)';
  g.fillRect(0, 0, 16, 1);
  g.fillRect(0, 0, 1, 16);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const LAN_TOPS = [
  ['#1f6f63', '#237a6d'],
  ['#2b5f8a', '#306a98'],
  ['#5a4a8e', '#64539c'],
  ['#7a5a2e', '#866434'],
];

function IslandMesh({ island, index }: { island: Island; index: number }) {
  const lan = island.kind === 'lan';
  const [a, b] = (lan ? LAN_TOPS[index % LAN_TOPS.length]! : ['#3c3f5c', '#444867']) as [string, string];
  const materials = useMemo(() => {
    const top = tileTexture(a, b);
    top.repeat.set(island.w / 2, island.d / 2);
    const side = new THREE.MeshStandardMaterial({ color: lan ? '#3a2a55' : '#2c2a44', flatShading: true });
    const topMat = new THREE.MeshStandardMaterial({ map: top, flatShading: true });
    return [side, side, topMat, side, side, side];
  }, [a, b, island.w, island.d, lan]);
  useEffect(() => () => materials.forEach((m) => (m as THREE.MeshStandardMaterial).map?.dispose()), [materials]);
  const h = lan ? 0.9 : 0.6;
  return (
    <group position={[island.cx, -h / 2 - 0.02, island.cz]}>
      <mesh material={materials} receiveShadow raycast={() => null}>
        <boxGeometry args={[island.w, h, island.d]} />
      </mesh>
      {/* stepped underside: reads as a floating chunk of land */}
      <mesh position={[0, -h * 0.9, 0]} raycast={() => null}>
        <boxGeometry args={[island.w * 0.82, h * 0.8, island.d * 0.82]} />
        <meshStandardMaterial color="#251b3a" flatShading />
      </mesh>
      <mesh position={[0, -h * 1.6, 0]} raycast={() => null}>
        <boxGeometry args={[island.w * 0.55, h * 0.6, island.d * 0.55]} />
        <meshStandardMaterial color="#1b1430" flatShading />
      </mesh>
    </group>
  );
}

export function Islands() {
  const topology = useSim((s) => s.topology);
  const islands = useMemo(() => computeIslands(topology), [topology]);
  let lanIdx = 0;
  return (
    <group>
      {islands.map((i) => (
        <IslandMesh key={`${i.id}-${i.w}-${i.d}`} island={i} index={i.kind === 'lan' ? lanIdx++ : 0} />
      ))}
    </group>
  );
}

/** Slowly drifting, twinkling voxel dust. */
export function Dust({ count = 260 }: { count?: number }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const seeds = useMemo(() => {
    let s = 7;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    return Array.from({ length: count }, () => ({ x: (r() - 0.5) * 90, y: -14 + r() * 30, z: (r() - 0.5) * 90, sp: 0.2 + r() * 0.6, ph: r() * 6.28, sz: 0.06 + r() * 0.12 }));
  }, [count]);
  const tmp = useMemo(() => ({ m: new THREE.Matrix4(), q: new THREE.Quaternion(), p: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Color() }), []);
  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    seeds.forEach((_, i) => m.setColorAt(i, tmp.c.set(i % 5 === 0 ? '#ffb020' : i % 3 === 0 ? '#5eead4' : '#8f86ff')));
  }, [seeds, tmp]);
  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m) return;
    const t = clock.elapsedTime;
    seeds.forEach((d, i) => {
      const k = d.sz * (0.6 + 0.4 * Math.sin(t * 2 * d.sp + d.ph));
      let y = d.y + ((t * d.sp * 0.4) % 30);
      if (y > 16) y -= 30;
      tmp.p.set(d.x + Math.sin(t * 0.1 * d.sp + d.ph) * 2, y, d.z);
      tmp.s.setScalar(k);
      tmp.m.compose(tmp.p, tmp.q, tmp.s);
      m.setMatrixAt(i, tmp.m);
    });
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, count]} frustumCulled={false} raycast={() => null}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial toneMapped={false} transparent opacity={0.75} />
    </instancedMesh>
  );
}

/**
 * Pixel-art rendering via three's RenderPixelatedPass: the scene is rendered at 1/pixelSize
 * resolution, scaled up with nearest filtering, with depth/normal edge highlights.
 * Takes over the render loop (priority 1) while enabled.
 */
export function Pixelation() {
  const { gl, scene, camera, size } = useThree();
  const pixelSize = useSim((s) => s.pixelSize);
  const composer = useMemo(() => {
    const c = new EffectComposer(gl);
    const pass = new RenderPixelatedPass(pixelSize, scene, camera, { normalEdgeStrength: 0.35, depthEdgeStrength: 0.5 });
    c.addPass(pass);
    c.addPass(new OutputPass());
    return c;
  }, [gl, scene, camera, pixelSize]);
  useEffect(() => {
    composer.setPixelRatio(1);
    composer.setSize(size.width, size.height);
  }, [composer, size]);
  useEffect(() => () => composer.dispose(), [composer]);
  useFrame(() => composer.render(), 1);
  return null;
}
