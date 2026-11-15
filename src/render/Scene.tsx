import { Grid } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { sim, useSim } from '../state/sim';
import { CameraRig } from './CameraRig';
import { Devices, type DeviceHandlers } from './Devices';
import { LabelProjector } from './Labels';
import { Links } from './Links';
import { Packets } from './Packets';

/** Drives the simulation clock from the render loop. */
function SimTicker() {
  useFrame((_, dt) => sim.tick(Math.min(dt, 0.1)));
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
  return (
    <Canvas
      className="scene"
      dpr={[1, 2]}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      onPointerMissed={() => {
        setSelection(null);
        onBackgroundClick?.();
      }}
    >
      <color attach="background" args={['#0b0f14']} />
      <fog attach="fog" args={['#0b0f14', 60, 160]} />
      <ambientLight intensity={0.55} />
      <hemisphereLight args={['#bcd7ff', '#1a1f26', 0.6]} />
      <directionalLight position={[12, 20, 8]} intensity={1.2} />
      <Grid
        args={[200, 200]}
        position={[0, -0.01, 0]}
        cellSize={1}
        cellThickness={0.5}
        cellColor="#16202b"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#1f2d3b"
        fadeDistance={90}
        fadeStrength={1.5}
        infiniteGrid
      />
      <CameraRig />
      <SimTicker />
      <Links />
      <Devices handlers={handlers} />
      <Packets />
      <LabelProjector />
      {children}
    </Canvas>
  );
}
