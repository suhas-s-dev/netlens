import { useEffect, useState } from 'react';
import { PRESETS } from '../presets';
import { LabelsLayer } from '../render/Labels';
import { Scene } from '../render/Scene';
import { sim, useSim } from '../state/sim';
import { CommandPanel } from './CommandPanel';
import { EventLog } from './EventLog';
import { Legend } from './Legend';
import { SidePanel } from './SidePanel';
import { TimeControls } from './TimeControls';
import { TopBar } from './TopBar';

export function App() {
  const mode = useSim((s) => s.mode);
  const [logOpen, setLogOpen] = useState(true);

  useEffect(() => {
    const p = PRESETS[0]!;
    sim.load(structuredClone(p.topology), p.id);
  }, []);

  return (
    <div className={`app ${logOpen ? '' : 'log-collapsed'}`}>
      <TopBar />
      <main className="scene-wrap">
        <Scene />
        <LabelsLayer />
        {mode === 'sim' && <CommandPanel />}
        <TimeControls />
        {mode === 'sim' && <Legend />}
      </main>
      <SidePanel />
      <EventLog open={logOpen} onToggle={() => setLogOpen((o) => !o)} />
    </div>
  );
}
