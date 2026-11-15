/** Sim time is an integer number of nanoseconds (safe up to ~104 days). */
export const NS = 1;
export const US = 1_000;
export const MS = 1_000_000;
export const SEC = 1_000_000_000;

export function formatTime(ns: number): string {
  if (ns >= SEC) return `${(ns / SEC).toFixed(6)} s`;
  return `${(ns / MS).toFixed(3)} ms`;
}

export function formatDuration(ns: number): string {
  if (ns >= SEC) return `${(ns / SEC).toFixed(3)} s`;
  if (ns >= MS) return `${(ns / MS).toFixed(3)} ms`;
  return `${(ns / US).toFixed(1)} µs`;
}
