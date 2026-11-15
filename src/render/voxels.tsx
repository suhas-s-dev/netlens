/** Voxel-style device models. Each is built from chunky boxes so the pixel pass gives
 * crisp outlines; LEDs and screens react to live traffic. */
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import * as THREE from 'three';
import { sim } from '../state/sim';

type V3 = [number, number, number];

function Box({ p, s, c, e, ei = 0.8, shadow = true }: { p: V3; s: V3; c: string; e?: string; ei?: number; shadow?: boolean }) {
  return (
    <mesh position={p} castShadow={shadow} receiveShadow>
      <boxGeometry args={s} />
      {e ? <meshStandardMaterial color={c} emissive={e} emissiveIntensity={ei} flatShading /> : <meshStandardMaterial color={c} flatShading />}
    </mesh>
  );
}

/** Is a frame currently leaving or arriving at (node, iface)? */
function portBusy(node: string, iface?: string): boolean {
  const t = sim.engine.now;
  for (const tx of sim.inFlight.values()) {
    if (tx.node === node && (!iface || tx.iface === iface) && t - tx.txStart < (tx.arrive - tx.txStart) * 0.35) return true;
    if (tx.toNode === node && (!iface || tx.toIface === iface) && tx.arrive - t < (tx.arrive - tx.txStart) * 0.35) return true;
  }
  return false;
}

/** Emissive material that flashes when `active()` is true. */
function useBlink(active: () => boolean, base = 0.25, peak = 2.6) {
  const ref = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    const m = ref.current;
    if (m) m.emissiveIntensity = THREE.MathUtils.lerp(m.emissiveIntensity, active() ? peak : base, 0.35);
  });
  return ref;
}

function Led({ p, color, active, s = [0.14, 0.1, 0.06] }: { p: V3; color: string; active: () => boolean; s?: V3 }) {
  const ref = useBlink(active);
  return (
    <mesh position={p}>
      <boxGeometry args={s} />
      <meshStandardMaterial ref={ref} color={color} emissive={color} emissiveIntensity={0.25} toneMapped={false} />
    </mesh>
  );
}

/** Retro beige PC: monitor with a glowing screen, tower, keyboard. */
export function HostVoxel({ nodeId }: { nodeId: string }) {
  const screen = useBlink(() => portBusy(nodeId), 0.55, 1.6);
  return (
    <group>
      {/* desk mat */}
      <Box p={[0, 0.04, 0.1]} s={[1.7, 0.08, 1.3]} c="#3d3360" shadow={false} />
      {/* tower */}
      <Box p={[-0.62, 0.48, -0.15]} s={[0.36, 0.8, 0.7]} c="#e3d6b5" />
      <Box p={[-0.62, 0.7, 0.21]} s={[0.24, 0.06, 0.02]} c="#5a5470" />
      <Led p={[-0.62, 0.3, 0.21]} color="#3ddc97" active={() => portBusy(nodeId)} s={[0.07, 0.07, 0.03]} />
      {/* monitor */}
      <Box p={[0.18, 0.95, -0.1]} s={[1.0, 0.78, 0.5]} c="#e8dcbd" />
      <mesh position={[0.18, 0.97, 0.155]}>
        <boxGeometry args={[0.8, 0.58, 0.02]} />
        <meshStandardMaterial ref={screen} color="#0f2a2a" emissive="#2fd6b8" emissiveIntensity={0.55} toneMapped={false} />
      </mesh>
      {/* screen "text" lines */}
      <Box p={[0.05, 1.1, 0.17]} s={[0.42, 0.05, 0.01]} c="#7ff5df" e="#7ff5df" ei={1.2} shadow={false} />
      <Box p={[0.12, 0.98, 0.17]} s={[0.56, 0.05, 0.01]} c="#7ff5df" e="#7ff5df" ei={1.2} shadow={false} />
      <Box p={[0.0, 0.86, 0.17]} s={[0.32, 0.05, 0.01]} c="#7ff5df" e="#7ff5df" ei={1.2} shadow={false} />
      <Box p={[0.18, 0.5, -0.1]} s={[0.24, 0.12, 0.24]} c="#cfc2a2" />
      {/* keyboard */}
      <Box p={[0.18, 0.13, 0.45]} s={[0.9, 0.08, 0.3]} c="#d8cba9" />
    </group>
  );
}

/** Rack switch with one LED per port that blinks with that port's traffic. */
export function SwitchVoxel({ nodeId, ports }: { nodeId: string; ports: string[] }) {
  const n = Math.max(ports.length, 1);
  const w = Math.max(2.4, n * 0.36 + 0.6);
  return (
    <group>
      <Box p={[0, 0.3, 0]} s={[w, 0.6, 1.3]} c="#34405f" />
      <Box p={[0, 0.62, 0]} s={[w - 0.2, 0.06, 1.1]} c="#3f4d72" />
      {/* front panel */}
      <Box p={[0, 0.3, 0.66]} s={[w - 0.16, 0.44, 0.02]} c="#1d2438" shadow={false} />
      {ports.map((pid, i) => {
        const x = -((n - 1) * 0.36) / 2 + i * 0.36;
        return (
          <group key={pid}>
            <Box p={[x, 0.24, 0.68]} s={[0.22, 0.16, 0.03]} c="#0c0f19" shadow={false} />
            <Led p={[x, 0.42, 0.68]} color="#5eead4" active={() => portBusy(nodeId, pid)} />
          </group>
        );
      })}
      {/* vent blocks on top */}
      {[-0.6, 0, 0.6].map((x) => (
        <Box key={x} p={[x, 0.66, -0.25]} s={[0.4, 0.04, 0.12]} c="#2a3350" shadow={false} />
      ))}
    </group>
  );
}

/** Chunky router with antennas and blinking status lights. */
export function RouterVoxel({ nodeId, ifaces }: { nodeId: string; ifaces: string[] }) {
  const tip = useBlink(() => portBusy(nodeId), 0.4, 3);
  return (
    <group>
      <Box p={[0, 0.38, 0]} s={[1.9, 0.76, 1.4]} c="#5b3f8f" />
      <Box p={[0, 0.8, 0]} s={[1.7, 0.08, 1.2]} c="#6d4fa8" />
      <Box p={[0, 0.38, 0.71]} s={[1.6, 0.4, 0.02]} c="#2a1d45" shadow={false} />
      {ifaces.map((id, i) => (
        <Led key={id} p={[-0.6 + i * 0.4, 0.38, 0.73]} color="#c4b5fd" active={() => portBusy(nodeId, id)} />
      ))}
      {/* antennas */}
      {[-0.65, 0.65].map((x) => (
        <group key={x}>
          <Box p={[x, 1.25, -0.45]} s={[0.1, 0.9, 0.1]} c="#2a1d45" />
          <mesh position={[x, 1.75, -0.45]}>
            <boxGeometry args={[0.18, 0.18, 0.18]} />
            <meshStandardMaterial ref={x < 0 ? tip : undefined} color="#ff4d6d" emissive="#ff4d6d" emissiveIntensity={0.6} toneMapped={false} />
          </mesh>
        </group>
      ))}
      {/* "arrows" emblem on top */}
      <Box p={[-0.3, 0.88, 0.1]} s={[0.5, 0.06, 0.12]} c="#c4b5fd" e="#c4b5fd" ei={0.5} shadow={false} />
      <Box p={[0.3, 0.88, -0.15]} s={[0.5, 0.06, 0.12]} c="#c4b5fd" e="#c4b5fd" ei={0.5} shadow={false} />
    </group>
  );
}
