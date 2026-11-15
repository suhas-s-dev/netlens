import { useEffect } from 'react';
import { sim, useSim } from '../state/sim';

/** Speed slider is logarithmic from 0.1x to 4x. */
const toSlider = (s: number) => Math.log(s / 0.1) / Math.log(40);
const fromSlider = (v: number) => Math.round(0.1 * Math.pow(40, v) * 100) / 100;

function fmtTime(ns: number): string {
  const s = ns / 1e9;
  return `${s.toFixed(6)} s`;
}

export function TimeControls() {
  const playing = useSim((s) => s.playing);
  const speed = useSim((s) => s.speed);
  const simTime = useSim((s) => s.simTime);
  const mode = useSim((s) => s.mode);
  useSim((s) => s.version);
  const setSpeed = useSim((s) => s.setSpeed);
  const inFlight = sim.inFlight.size;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      if (useSim.getState().mode !== 'sim') return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (useSim.getState().playing) sim.pause();
        else sim.play();
      } else if (e.key === '.' || e.key === 'ArrowRight') {
        e.preventDefault();
        sim.stepEvent();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (mode !== 'sim') return null;
  return (
    <div className="overlay card timebar" role="toolbar" aria-label="Time controls">
      <button className="btn icon" title="Reset to t=0 (re-runs the scenario)" onClick={() => sim.reset()}>
        ⟲
      </button>
      <button className="btn icon primary" title="Play / pause (Space)" onClick={() => (playing ? sim.pause() : sim.play())} style={{ minWidth: 70 }}>
        {playing ? '❚❚ Pause' : '▶ Play'}
      </button>
      <button className="btn icon" title="Step to the next event (. or →)" onClick={() => sim.stepEvent()}>
        ⏭ Step
      </button>
      <input type="range" min={0} max={1} step={0.001} value={toSlider(speed)} onChange={(e) => setSpeed(fromSlider(Number(e.target.value)))} aria-label="Speed" />
      <span className="speed">{speed.toFixed(speed < 1 ? 2 : 1)}x</span>
      <span className="time" title="Simulation time">t = {fmtTime(simTime)}</span>
      <span className="meta">{inFlight} on wire</span>
    </div>
  );
}
