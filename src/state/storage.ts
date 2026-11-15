/** localStorage persistence + JSON import/export for topologies. Every access is guarded:
 * storage can be unavailable (private mode, blocked site data). */
import type { TopologyJson } from '../engine';

const KEY = 'netlens:saved:v1';
const AUTOSAVE = 'netlens:autosave:v1';

export interface SavedTopology {
  name: string;
  savedAt: number;
  topology: TopologyJson;
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function listSaved(): SavedTopology[] {
  return read<SavedTopology[]>(KEY, []).sort((a, b) => b.savedAt - a.savedAt);
}

export function saveTopology(name: string, topology: TopologyJson): boolean {
  const all = listSaved().filter((s) => s.name !== name);
  all.push({ name, savedAt: Date.now(), topology: { ...topology, name } });
  return write(KEY, all);
}

export function deleteSaved(name: string): void {
  write(KEY, listSaved().filter((s) => s.name !== name));
}

export function autosave(topology: TopologyJson): void {
  write(AUTOSAVE, topology);
}

export function loadAutosave(): TopologyJson | null {
  return read<TopologyJson | null>(AUTOSAVE, null);
}

/** Structural check of untrusted JSON before it reaches the engine. */
export function parseTopology(text: string): TopologyJson {
  const t = JSON.parse(text) as Partial<TopologyJson>;
  if (!t || typeof t !== 'object') throw new Error('Not a JSON object');
  if (t.version !== 1) throw new Error('Unsupported topology version (expected "version": 1)');
  if (!Array.isArray(t.nodes) || !Array.isArray(t.links)) throw new Error('Missing "nodes" or "links" array');
  for (const n of t.nodes) {
    if (!n || typeof n.id !== 'string' || typeof n.name !== 'string') throw new Error('Every node needs a string id and name');
    if (!['host', 'switch', 'router'].includes(n.type)) throw new Error(`Node ${n.id}: unknown type "${String(n.type)}"`);
    if (!n.position || typeof n.position.x !== 'number' || typeof n.position.y !== 'number') throw new Error(`Node ${n.id}: missing position {x, y}`);
    if (!Array.isArray(n.interfaces)) throw new Error(`Node ${n.id}: missing interfaces`);
    if (n.type === 'router' && !Array.isArray(n.staticRoutes)) (n as { staticRoutes: unknown[] }).staticRoutes = [];
  }
  for (const l of t.links) {
    if (!l || typeof l.id !== 'string' || !l.a || !l.b) throw new Error('Every link needs an id and two endpoints');
  }
  return { version: 1, name: typeof t.name === 'string' ? t.name : 'Imported', nodes: t.nodes, links: t.links, ...(t.description ? { description: t.description } : {}), ...(t.scenario ? { scenario: t.scenario } : {}), ...(t.seed !== undefined ? { seed: t.seed } : {}) };
}

export function downloadJson(topology: TopologyJson): void {
  const blob = new Blob([JSON.stringify(topology, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${topology.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'topology'}.netlens.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
