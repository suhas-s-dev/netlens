import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { NodeJson } from '../engine';
import { sim, useSim } from '../state/sim';
import { DEVICE_COLORS } from './colors';
import { linkGeometry, nodePos, portAnchors } from './layout';

export interface DeviceHandlers {
  onPointerDown?: (node: NodeJson, e: ThreeEvent<PointerEvent>) => void;
  onPortClick?: (node: NodeJson, iface: string, e: ThreeEvent<MouseEvent>) => void;
}

function HostMesh({ accent, body }: { accent: string; body: string }) {
  return (
    <group>
      <mesh position={[0, 0.06, 0]} castShadow>
        <boxGeometry args={[1.0, 0.12, 0.7]} />
        <meshStandardMaterial color={body} flatShading />
      </mesh>
      <mesh position={[0, 0.35, 0]}>
        <boxGeometry args={[0.12, 0.5, 0.12]} />
        <meshStandardMaterial color={body} flatShading />
      </mesh>
      <mesh position={[0, 0.95, 0]} castShadow>
        <boxGeometry args={[1.5, 0.95, 0.12]} />
        <meshStandardMaterial color={body} flatShading />
      </mesh>
      <mesh position={[0, 0.95, 0.065]}>
        <planeGeometry args={[1.32, 0.78]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.35} />
      </mesh>
    </group>
  );
}

function SwitchMesh({ accent, body, ports }: { accent: string; body: string; ports: number }) {
  return (
    <group>
      <mesh position={[0, 0.25, 0]} castShadow>
        <boxGeometry args={[2.6, 0.5, 1.3]} />
        <meshStandardMaterial color={body} flatShading />
      </mesh>
      <mesh position={[0, 0.505, 0]}>
        <boxGeometry args={[2.4, 0.02, 1.1]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.15} />
      </mesh>
      {Array.from({ length: ports }, (_, i) => (
        <mesh key={i} position={[-1.05 + (2.1 / Math.max(1, ports - 1)) * i, 0.25, 0.66]}>
          <boxGeometry args={[0.16, 0.12, 0.02]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.5} />
        </mesh>
      ))}
    </group>
  );
}

function RouterMesh({ accent, body }: { accent: string; body: string }) {
  return (
    <group>
      <mesh position={[0, 0.3, 0]} castShadow>
        <cylinderGeometry args={[1.05, 1.05, 0.6, 10]} />
        <meshStandardMaterial color={body} flatShading />
      </mesh>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[Math.cos((i * Math.PI) / 2) * 0.5, 0.65, Math.sin((i * Math.PI) / 2) * 0.5]} rotation={[0, -(i * Math.PI) / 2, -Math.PI / 2]}>
          <coneGeometry args={[0.14, 0.32, 4]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.4} flatShading />
        </mesh>
      ))}
    </group>
  );
}

function Device({ node, handlers }: { node: NodeJson; handlers: DeviceHandlers }) {
  const selected = useSim((s) => s.selection?.kind === 'node' && s.selection.id === node.id);
  const mode = useSim((s) => s.mode);
  const focusNode = useSim((s) => s.focusNode);
  const setSelection = useSim((s) => s.setSelection);
  const ringRef = useRef<THREE.Mesh>(null);
  const { body, accent } = DEVICE_COLORS[node.type];
  const pos = nodePos(node);

  useFrame(({ clock }) => {
    if (ringRef.current) ringRef.current.rotation.z = clock.elapsedTime * 0.6;
  });

  return (
    <group position={pos}>
      <group
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
        {node.type === 'host' && <HostMesh body={body} accent={accent} />}
        {node.type === 'switch' && <SwitchMesh body={body} accent={accent} ports={node.interfaces.length} />}
        {node.type === 'router' && <RouterMesh body={body} accent={accent} />}
        {/* generous invisible hit area */}
        <mesh position={[0, 0.5, 0]} visible={false}>
          <cylinderGeometry args={[1.3, 1.3, 1.4, 8]} />
        </mesh>
      </group>
      {selected && (
        <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
          <ringGeometry args={[1.55, 1.75, 6]} />
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
