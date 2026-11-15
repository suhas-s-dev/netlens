import { useEffect, useState } from 'react';
import { PRESETS } from '../presets';
import { EditorLayer, editorHandlers } from '../render/EditorLayer';
import { LabelsLayer } from '../render/Labels';
import { Scene } from '../render/Scene';
import { removeLink, removeNode } from '../state/editOps';
import { sim, useSim } from '../state/sim';
import { CommandPanel } from './CommandPanel';
import { Palette } from './editor/Palette';
import { EventLog } from './EventLog';
import { Glossary } from './learn/Glossary';
import { LessonCard } from './learn/LessonCard';
import { Legend } from './Legend';
import { PacketHoverCard } from './PacketHoverCard';
import { useLesson } from '../state/lesson';
import { SidePanel } from './SidePanel';
import { TimeControls } from './TimeControls';
import { Toast } from './Toast';
import { TopBar } from './TopBar';

function useEditorKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useSim.getState();
      if (s.mode !== 'edit' || (e.target as HTMLElement).closest('input, textarea, select')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && s.selection) {
        e.preventDefault();
        const sel = s.selection;
        if (sel.kind === 'node') s.editTopology((t) => removeNode(t, sel.id));
        else if (sel.kind === 'link') s.editTopology((t) => removeLink(t, sel.id));
        s.setSelection(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const mode = useSim((s) => s.mode);
  const inLesson = useLesson((s) => !!s.lesson);
  const [logOpen, setLogOpen] = useState(true);
  useEditorKeys();

  useEffect(() => {
    const p = PRESETS[0]!;
    sim.load(structuredClone(p.topology), p.id);
  }, []);

  return (
    <div className={`app ${logOpen ? '' : 'log-collapsed'}`}>
      <TopBar />
      <main className="scene-wrap">
        <Scene handlers={editorHandlers} onBackgroundClick={() => useSim.getState().setLinkStart(null)}>
          {mode === 'edit' && <EditorLayer />}
        </Scene>
        <LabelsLayer />
        {mode === 'sim' ? inLesson ? <LessonCard /> : <CommandPanel /> : <Palette />}
        <TimeControls />
        {mode === 'sim' && !inLesson && <Legend />}
        <Toast />
        <Glossary />
      </main>
      <PacketHoverCard />
      <SidePanel />
      <EventLog open={logOpen} onToggle={() => setLogOpen((o) => !o)} />
    </div>
  );
}
