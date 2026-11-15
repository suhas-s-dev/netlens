import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect } from 'react';
import { sim, useSim } from '../state/sim';
import { CameraRig } from './CameraRig';
import { Devices, type DeviceHandlers } from './Devices';
import { DropBursts } from './DropBursts';
import { LabelProjector } from './Labels';
import { Links } from './Links';
import { Packets } from './Packets';
import { Dust, Islands, Pixelation, Sky } from './World';

/** Drives the simulation clock from the render loop. */
function SimTicker() {
  useFrame((_, dt) => sim.tick(Math.min(dt, 0.1)));
  return null;
}

/** Dev-only: expose the r3f store so frame cost can be measured from the console. */
function DevHandle() {
  const get = useThree((s) => s.get);
  useEffect(() => {
    if (import.meta.env.DEV) Object.assign((window as unknown as { __netlens: object }).__netlens ?? {}, { r3f: get });
  }, [get]);
  return null;
}

export interface SceneProps {
  handlers?: DeviceHandlers;
  /** Extra scene content (editor ground plane, link preview). */
  children?: React.ReactNode;
  onBackgroundClick?: () => void;
}

export function Scene({ handlers, children, onBackgroundClick }: SceneProps) {
  const setSelection = useSim((s) => s.setSelection);
  const pixel = useSim((s) => s.pixel);
  return (
    <Canvas
      className="scene"
      dpr={[1, 2]}
      shadows
      gl={{ antialias: !pixel, powerPreference: 'high-performance' }}
      onPointerMissed={() => {
        setSelection(null);
        onBackgroundClick?.();
      }}
    >
      <color attach="background" args={['#0d0b1e']} />
      <fog attach="fog" args={['#14103a', 70, 170]} />
      <Sky />
      <ambientLight intensity={0.5} color="#b9b2ff" />
      <hemisphereLight args={['#c7d2ff', '#2a1b4a', 0.7]} />
      <directionalLight
        position={[14, 26, 10]}
        intensity={1.5}
        color="#fff3dc"
        castShadow
        shadow-mapSize={[1024, 1024]}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
        shadow-bias={-0.0005}
      />
      <Islands />
      <Dust />
      <CameraRig />
      <SimTicker />
      <DevHandle />
      <Links />
      <Devices handlers={handlers} />
      <Packets />
      <DropBursts />
      <LabelProjector />
      {children}
      {pixel && <Pixelation />}
    </Canvas>
  );
}
