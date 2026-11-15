/** Edit-mode scene interactions: drag devices on the ground plane, link port-to-port. */
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { NodeJson } from '../engine';
import { connect, moveNode } from '../state/editOps';
import { useSim } from '../state/sim';
import type { DeviceHandlers } from './Devices';
import { freePortPositions, linkGeometry, nodePos, portAnchors } from './layout';

const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const drag = { id: null as string | null, offset: new THREE.Vector3(), moved: false };
const snap = (v: number) => Math.round(v * 2) / 2;

/** Port click while editing: first click picks the start port, second click links. */
export function clickPort(nodeId: string, iface: string): void {
  const s = useSim.getState();
  const t = s.topology;
  const linked = t.links.find((l) => (l.a.node === nodeId && l.a.iface === iface) || (l.b.node === nodeId && l.b.iface === iface));
  if (!s.linkStart) {
    if (linked) {
      s.setSelection({ kind: 'link', id: linked.id });
      return;
    }
    s.setLinkStart({ node: nodeId, iface });
    return;
  }
  const start = s.linkStart;
  if (start.node === nodeId && start.iface === iface) {
    s.setLinkStart(null);
    return;
  }
  const r = connect(t, start, { node: nodeId, iface });
  if (typeof r === 'string') {
    s.showToast(r);
    return;
  }
  s.editTopology(() => r);
  s.setLinkStart(null);
  s.setSelection({ kind: 'link', id: r.links[r.links.length - 1]!.id });
}

export const editorHandlers: DeviceHandlers = {
  onPointerDown(node: NodeJson, e: ThreeEvent<PointerEvent>) {
    if (useSim.getState().mode !== 'edit' || e.button !== 0) return;
    e.stopPropagation();
    const hit = new THREE.Vector3();
    if (!e.ray.intersectPlane(GROUND, hit)) return;
    drag.id = node.id;
    drag.moved = false;
    drag.offset.copy(nodePos(node)).sub(hit);
    useSim.getState().setSelection({ kind: 'node', id: node.id });
  },
  onPortClick(node, iface) {
    if (useSim.getState().mode === 'edit') clickPort(node.id, iface);
  },
};

function FreePorts() {
  const topology = useSim((s) => s.topology);
  const linkStart = useSim((s) => s.linkStart);
  const ports = useMemo(() => [...freePortPositions(topology).entries()], [topology]);
  return (
    <group>
      {ports.map(([key, p]) => {
        const [nodeId, iface] = key.split('.') as [string, string];
        const active = linkStart?.node === nodeId && linkStart.iface === iface;
        return (
          <mesh
            key={key}
            position={p}
            onClick={(e) => {
              e.stopPropagation();
              clickPort(nodeId, iface);
            }}
            onPointerOver={(e) => {
              e.stopPropagation();
              document.body.style.cursor = 'crosshair';
            }}
            onPointerOut={() => (document.body.style.cursor = '')}
          >
            <sphereGeometry args={[active ? 0.2 : 0.15, 12, 10]} />
            <meshStandardMaterial color={active ? '#fbbf24' : '#64748b'} emissive={active ? '#fbbf24' : '#334155'} emissiveIntensity={active ? 1.5 : 0.5} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Rubber-band line from the picked port to the pointer. */
function LinkPreview() {
  const linkStart = useSim((s) => s.linkStart);
  const topology = useSim((s) => s.topology);
  const mesh = useRef<THREE.Mesh>(null);
  const { raycaster, pointer, camera } = useThree();
  const from = useMemo(() => {
    if (!linkStart) return null;
    const key = `${linkStart.node}.${linkStart.iface}`;
    return freePortPositions(topology).get(key) ?? portAnchors(linkGeometry(topology)).get(key) ?? null;
  }, [linkStart, topology]);
  const tmp = useMemo(() => ({ to: new THREE.Vector3(), mid: new THREE.Vector3(), dir: new THREE.Vector3(), q: new THREE.Quaternion(), up: new THREE.Vector3(0, 1, 0) }), []);

  useFrame(() => {
    const m = mesh.current;
    if (!m || !from) return;
    raycaster.setFromCamera(pointer, camera);
    if (!raycaster.ray.intersectPlane(GROUND, tmp.to)) return;
    tmp.to.y = from.y;
    tmp.dir.subVectors(tmp.to, from);
    const len = tmp.dir.length();
    m.visible = len > 0.05;
    tmp.mid.addVectors(from, tmp.to).multiplyScalar(0.5);
    m.position.copy(tmp.mid);
    m.quaternion.copy(tmp.q.setFromUnitVectors(tmp.up, tmp.dir.normalize()));
    m.scale.set(1, len, 1);
  });

  if (!from) return null;
  return (
    <mesh ref={mesh} raycast={() => null}>
      <cylinderGeometry args={[0.04, 0.04, 1, 6, 1, true]} />
      <meshBasicMaterial color="#fbbf24" transparent opacity={0.8} toneMapped={false} />
    </mesh>
  );
}

export function EditorLayer() {
  const { camera, gl, controls, raycaster } = useThree();

  useEffect(() => {
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();
    const ctl = controls as unknown as { enabled: boolean } | null;
    const onMove = (e: PointerEvent) => {
      if (!drag.id) return;
      if (ctl) ctl.enabled = false;
      const r = gl.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(GROUND, hit)) return;
      hit.add(drag.offset);
      const id = drag.id;
      const pos = { x: snap(hit.x), y: snap(hit.z) };
      const cur = useSim.getState().topology.nodes.find((n) => n.id === id)?.position;
      if (cur && (cur.x !== pos.x || cur.y !== pos.y)) {
        drag.moved = true;
        useSim.getState().editTopology((t) => moveNode(t, id, pos));
      }
    };
    const onUp = () => {
      drag.id = null;
      if (ctl) ctl.enabled = true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useSim.getState().setLinkStart(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      onUp();
    };
  }, [camera, gl, controls, raycaster]);

  return (
    <>
      <FreePorts />
      <LinkPreview />
    </>
  );
}
