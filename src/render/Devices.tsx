import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { NodeJson } from '../engine';
import { sim, useSim } from '../state/sim';
import { DEVICE_COLORS } from './colors';
import { linkGeometry, nodePos, portAnchors } from './layout';
import { HostVoxel, RouterVoxel, SwitchVoxel } from './voxels';

export interface DeviceHandlers {
  onPointerDown?: (node: NodeJson, e: ThreeEvent<PointerEvent>) => void;
  onPortClick?: (node: NodeJson, iface: string, e: ThreeEvent<MouseEvent>) => void;
}

function Device({ node, handlers }: { node: NodeJson; handlers: DeviceHandlers }) {
  const selected = useSim((s) => s.selection?.kind === 'node' && s.selection.id === node.id);
  const mode = useSim((s) => s.mode);
  const focusNode = useSim((s) => s.focusNode);
  const setSelection = useSim((s) => s.setSelection);
  const ringRef = useRef<THREE.Mesh>(null);
  const { accent } = DEVICE_COLORS[node.type];
  const pos = nodePos(node);
  const bob = useRef<THREE.Group>(null);
  const phase = useMemo(() => (node.position.x * 1.7 + node.position.y * 2.3) % 6.28, [node.position.x, node.position.y]);

  useFrame(({ clock }) => {
    if (ringRef.current) ringRef.current.rotation.z = clock.elapsedTime * 0.6;
    // gentle idle bob, like a floating diorama piece
    if (bob.current) bob.current.position.y = Math.sin(clock.elapsedTime * 1.4 + phase) * 0.04;
  });

  return (
    <group position={pos}>
      <group
        ref={bob}
        onClick={(e) => {
          e.stopPropagation();
          setSelection({ kind: 'node', id: node.id });
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          focusNode(node.id);
        }}
        onPointerDown={(e) => handlers.onPointerDown?.(node, e)}
        onPointerOver={(e) => {
          e.stopPropagation();
          document.body.style.cursor = mode === 'edit' ? 'grab' : 'pointer';
        }}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        {node.type === 'host' && <HostVoxel nodeId={node.id} />}
        {node.type === 'switch' && <SwitchVoxel nodeId={node.id} ports={node.interfaces.map((i) => i.id)} />}
        {node.type === 'router' && <RouterVoxel nodeId={node.id} ifaces={node.interfaces.map((i) => i.id)} />}
        {/* generous invisible hit area */}
        <mesh position={[0, 0.5, 0]} visible={false}>
          <cylinderGeometry args={[1.3, 1.3, 1.4, 8]} />
        </mesh>
      </group>
      {selected && (
        <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[1.6, 1.85, 4]} />
          <meshBasicMaterial color={accent} transparent opacity={0.9} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

/** Small spheres where links attach; flash when a frame leaves or arrives. Mid/near LOD. */
function PortIndicators({ handlers }: { handlers: DeviceHandlers }) {
  const topology = useSim((s) => s.topology);
  const lod = useSim((s) => s.lod);
  const mode = useSim((s) => s.mode);
  const anchors = useMemo(() => portAnchors(linkGeometry(topology)), [topology]);
  const refs = useRef(new Map<string, THREE.MeshStandardMaterial>());

  useFrame(() => {
    // A port glows while a frame is leaving it (serializing) or about to arrive at it.
    const t = sim.engine.now;
    const active = new Set<string>();
    for (const tx of sim.inFlight.values()) {
      const window = Math.max(tx.txEnd - tx.txStart, (tx.arrive - tx.txEnd) * 0.2);
      if (t - tx.txStart < window) active.add(`${tx.node}.${tx.iface}`);
      if (tx.arrive - t < window) active.add(`${tx.toNode}.${tx.toIface}`);
    }
    for (const [k, m] of refs.current) {
      m.emissiveIntensity = THREE.MathUtils.lerp(m.emissiveIntensity, active.has(k) ? 2.5 : 0.25, 0.3);
    }
  });

  const show = lod !== 'far' || mode === 'edit';
  if (!show) return null;
  const nodes = new Map(topology.nodes.map((n) => [n.id, n]));
  return (
    <group>
      {[...anchors.entries()].map(([key, p]) => {
        const [nodeId, iface] = key.split('.') as [string, string];
        const node = nodes.get(nodeId)!;
        return (
          <group key={key} position={p}>
            <mesh
              onClick={(e) => {
                if (handlers.onPortClick) {
                  e.stopPropagation();
                  handlers.onPortClick(node, iface, e);
                }
              }}
            >
              <sphereGeometry args={[0.13, 10, 8]} />
              <meshStandardMaterial
                ref={(m) => {
                  if (m) refs.current.set(key, m);
                  else refs.current.delete(key);
                }}
                color="#5eead4"
                emissive="#5eead4"
                emissiveIntensity={0.25}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

export function Devices({ handlers = {} }: { handlers?: DeviceHandlers }) {
  const nodes = useSim((s) => s.topology.nodes);
  return (
    <group>
      {nodes.map((n) => (
        <Device key={n.id} node={n} handlers={handlers} />
      ))}
      <PortIndicators handlers={handlers} />
    </group>
  );
}
