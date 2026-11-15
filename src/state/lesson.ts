/** Runs a guided lesson: plays the sim until the current step's trigger event, pauses
 * exactly there, focuses the device and shows the step card. */
import { create } from 'zustand';
import { LESSONS, type Lesson } from '../learn/lessons';
import { PRESETS } from '../presets';
import { sim, useSim } from './sim';

interface LessonState {
  lesson: Lesson | null;
  step: number;
  /** 'show' = card visible, sim paused; 'wait' = sim playing until the trigger. */
  phase: 'show' | 'wait';
  picked: number | null;
}

export const useLesson = create<LessonState>(() => ({ lesson: null, step: 0, phase: 'show', picked: null }));

function show(step: number): void {
  const { lesson } = useLesson.getState();
  if (!lesson) return;
  const s = lesson.steps[step];
  if (!s) return;
  useLesson.setState({ step, phase: 'show', picked: null });
  if (s.focus) useSim.getState().focusNode(s.focus);
}

function arm(step: number): void {
  const { lesson } = useLesson.getState();
  const s = lesson?.steps[step];
  if (!lesson || !s) return;
  if (!s.when) {
    show(step);
    return;
  }
  const when = s.when;
  useLesson.setState({ step, phase: 'wait', picked: null });
  sim.watcher = when;
  sim.onWatchHit = () => {
    sim.watcher = null;
    sim.onWatchHit = null;
    show(step);
  };
  sim.play();
}

export function startLesson(presetId: string): void {
  const lesson = LESSONS[presetId];
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!lesson || !preset) return;
  useSim.getState().setMode('sim');
  sim.load(structuredClone(preset.topology), preset.id);
  useSim.getState().setSpeed(Math.min(useSim.getState().speed, 1));
  useSim.setState({ narration: true });
  lessonGen = useSim.getState().engineGen;
  useLesson.setState({ lesson, step: 0, phase: 'show', picked: null });
  arm(0);
}

export function nextStep(): void {
  const { lesson, step } = useLesson.getState();
  if (!lesson) return;
  if (step + 1 >= lesson.steps.length) {
    exitLesson();
    return;
  }
  arm(step + 1);
}

export function pickAnswer(i: number): void {
  useLesson.setState({ picked: i });
}

export function exitLesson(): void {
  sim.watcher = null;
  sim.onWatchHit = null;
  useLesson.setState({ lesson: null, step: 0, phase: 'show', picked: null });
}

// Reloading or resetting the simulation ends the lesson (its steps assume a fresh run).
let lessonGen = -1;
useSim.subscribe((s) => {
  if (useLesson.getState().lesson && s.engineGen !== lessonGen) exitLesson();
});
