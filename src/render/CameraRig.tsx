/** Cameras (perspective 3D / orthographic isometric), orbit controls, fly-to and LOD. */
import { OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef, type ComponentRef } from 'react';
import * as THREE from 'three';
import { useSim } from '../state/sim';
import { nodePos } from './layout';

type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

const ISO_DIR = new THREE.Vector3(1, 1.15, 1).normalize();
const PERSP_DIR = new THREE.Vector3(0, 1.1, 1.05).normalize();

interface Flight {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromZoom: number;
  toZoom: number;
  t: number;
}

function bounds(nodes: { position: { x: number; y: number } }[]) {
  const box = new THREE.Box3();
  for (const n of nodes) box.expandByPoint(new THREE.Vector3(n.position.x, 0, n.position.y));
  if (box.isEmpty()) box.set(new THREE.Vector3(-5, 0, -5), new THREE.Vector3(5, 0, 5));
  const centre = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  return { centre, radius: Math.max(6, Math.hypot(size.x, size.z) / 2 + 3) };
}

export function CameraRig() {
  const viewMode = useSim((s) => s.viewMode);
  const engineGen = useSim((s) => s.engineGen);
  const focus = useSim((s) => s.focus);
  const mode = useSim((s) => s.mode);
  const controls = useRef<OrbitControlsImpl>(null);
  const flight = useRef<Flight | null>(null);
  const { camera, size } = useThree();

  const dir = viewMode === 'iso' ? ISO_DIR : PERSP_DIR;

  /** Distance / zoom that frames a sphere of `radius`. */
  const frame = (radius: number) => {
    if (camera instanceof THREE.PerspectiveCamera) {
      const fov = THREE.MathUtils.degToRad(camera.fov);
      const fit = radius / Math.sin(fov / 2);
      return { dist: fit / Math.min(1, camera.aspect) ** 0.5, zoom: 1 };
    }
    return { dist: 60, zoom: Math.min(size.width, size.height) / (radius * 2.3) };
  };

  const flyTo = (target: THREE.Vector3, radius: number) => {
    const c = controls.current;
    if (!c) return;
    const { dist, zoom } = frame(radius);
    const curDir = camera.position.clone().sub(c.target).normalize();
    const useDir = viewMode === 'iso' ? dir : curDir.lengthSq() > 0 ? curDir : dir;
    flight.current = {
      fromPos: camera.position.clone(),
      toPos: target.clone().addScaledVector(useDir, dist),
      fromTarget: c.target.clone(),
      toTarget: target.clone(),
      fromZoom: camera.zoom,
      toZoom: zoom,
      t: 0,
    };
  };

  // Fit the whole topology when a new engine/topology loads or the view mode changes.
  useEffect(() => {
    const { centre, radius } = bounds(useSim.getState().topology.nodes);
    const c = controls.current;
    if (!c) return;
    const { dist, zoom } = frame(radius);
    camera.position.copy(centre).addScaledVector(dir, dist);
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    c.target.copy(centre);
    c.update();
  }, [engineGen, viewMode, camera]);

  useEffect(() => {
    if (!focus) return;
    const n = useSim.getState().topology.nodes.find((x) => x.id === focus.nodeId);
    if (n) flyTo(nodePos(n), 4.5);
  }, [focus]);

  useFrame((_, dt) => {
    const c = controls.current;
    if (!c) return;
    const f = flight.current;
    if (f) {
      f.t = Math.min(1, f.t + dt / 0.7);
      const k = 1 - Math.pow(1 - f.t, 3);
      camera.position.lerpVectors(f.fromPos, f.toPos, k);
      c.target.lerpVectors(f.fromTarget, f.toTarget, k);
      camera.zoom = THREE.MathUtils.lerp(f.fromZoom, f.toZoom, k);
      camera.updateProjectionMatrix();
      c.update();
      if (f.t >= 1) flight.current = null;
    }
    // Level of detail from camera distance (perspective) or zoom (orthographic).
    let lod: 'far' | 'mid' | 'near';
    if (camera instanceof THREE.PerspectiveCamera) {
      const d = camera.position.distanceTo(c.target);
      lod = d < 15 ? 'near' : d < 34 ? 'mid' : 'far';
    } else {
      const unitsVisible = Math.min(size.width, size.height) / camera.zoom;
      lod = unitsVisible < 16 ? 'near' : unitsVisible < 34 ? 'mid' : 'far';
    }
    useSim.getState().setLod(lod);
  });

  return (
    <>
      {viewMode === 'perspective' ? (
        <PerspectiveCamera key="p" makeDefault fov={45} near={0.1} far={500} position={[0, 25, 25]} />
      ) : (
        <OrthographicCamera key="o" makeDefault near={-200} far={500} position={[30, 34, 30]} zoom={20} />
      )}
      <OrbitControls
        key={viewMode}
        ref={controls}
        makeDefault
        enableDamping
        dampingFactor={0.12}
        enableRotate={viewMode === 'perspective' && mode !== 'edit'}
        maxPolarAngle={Math.PI / 2.15}
        screenSpacePanning={viewMode === 'iso'}
        mouseButtons={{ LEFT: viewMode === 'iso' || mode === 'edit' ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
      />
    </>
  );
}
