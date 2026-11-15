/**
 * Bridge between the pure engine and the UI.
 *
 * `sim` (SimController) owns the Engine instance and the playback clock. It subscribes to
 * trace events, keeps the set of frames currently on a wire (read every animation frame by
 * the renderer, without React), and flushes batched updates into the zustand store.
 * UI code never mutates the engine: it calls controller commands.
 */
import { create } from 'zustand';
import { Engine, MS, SEC, type DeviceState, type LinkEndJson, type TopologyJson, type TraceEvent, type TxEvent } from '../engine';
import type { ConceptId } from '../learn/concepts';
import { buildCtx, explain, type ExplainCtx, type Tone } from '../learn/explain';
import { materializeMacs } from './editOps';
import { autosave } from './storage';

/** At 1x, this much sim time passes per wall-clock second. Links default to 2 ms, so a hop
 * takes ~0.4 s on screen. */
export const BASE_NS_PER_SEC = 5 * MS;
/** When nothing is on the wire, time runs at least this fast (sim ns per wall second, x speed). */
const IDLE_NS_PER_SEC = 1 * SEC;
/** ... and a gap this short is skipped outright after a brief idle pause. */
const IDLE_SKIP_MAX = 3 * SEC;
const IDLE_PAUSE_WALL = 0.35;
const LOG_LIMIT = 4000;
const PACKET_INDEX_LIMIT = 6000;

export type Selection = { kind: 'node'; id: string } | { kind: 'packet'; id: string } | { kind: 'link'; id: string };

export interface Highlight {
  op: string;
  /** performance.now() when it happened. */
  at: number;
}

export interface BubbleLine {
  say: string;
  tone: Tone;
  concept?: ConceptId;
}

/** A device's current speech bubble. Lines that happen at the same sim instant are merged. */
export interface Bubble {
  lines: BubbleLine[];
  /** performance.now() when last updated (drives the fade). */
  at: number;
  simTime: number;
  n: number;
}

export interface SimStore {
  topology: TopologyJson;
  presetId: string | null;
  engineGen: number;
  /** Bumped when the camera should re-fit the whole topology. */
  fitGen: number;
  /** Topology edited since the engine was built. */
  dirty: boolean;
  toast: { text: string; n: number } | null;
  /** Editor: first port picked when linking port-to-port. */
  linkStart: LinkEndJson | null;
  playing: boolean;
  speed: number;
  simTime: number;
  /** Bumped whenever engine state may have changed (UI re-reads getState). */
  version: number;
  log: TraceEvent[];
  selection: Selection | null;
  /** Camera fly-to requests. */
  focus: { nodeId: string; n: number } | null;
  viewMode: 'perspective' | 'iso';
  mode: 'sim' | 'edit';
  lod: 'far' | 'mid' | 'near';
  logFilter: { node: string | null; types: Record<string, boolean> };
  highlights: Record<string, Highlight>;
  /** Learning layer. */
  bubbles: Record<string, Bubble>;
  narration: boolean;
  explainLog: boolean;
  /** Glossary panel: a concept id, 'index' for the list, or closed. */
  glossary: ConceptId | 'index' | null;
  /** Packet under the pointer, with screen position for the hover card. */
  hover: { id: string; x: number; y: number } | null;
  /** Rendering. */
  pixel: boolean;
  pixelSize: number;
  set<K extends keyof SimStore>(k: K, v: SimStore[K]): void;
  setSelection(s: Selection | null): void;
  setSpeed(s: number): void;
  setViewMode(v: 'perspective' | 'iso'): void;
  setMode(m: 'sim' | 'edit'): void;
  setLod(l: 'far' | 'mid' | 'near'): void;
  setLogFilter(f: Partial<SimStore['logFilter']>): void;
  focusNode(id: string): void;
  editTopology(fn: (t: TopologyJson) => TopologyJson): void;
  showToast(text: string): void;
  setLinkStart(e: LinkEndJson | null): void;
}

export const useSim = create<SimStore>((set, get) => ({
  topology: { version: 1, name: 'Empty', nodes: [], links: [] },
  presetId: null,
  engineGen: 0,
  fitGen: 0,
  dirty: false,
  toast: null,
  linkStart: null,
  playing: false,
  speed: 1,
  simTime: 0,
  version: 0,
  log: [],
  selection: null,
  focus: null,
  viewMode: 'perspective',
  mode: 'sim',
  lod: 'far',
  logFilter: { node: null, types: { tx: true, rx: false, drop: true, table: true, decision: true, app: true } },
  highlights: {},
  bubbles: {},
  narration: true,
  explainLog: true,
  glossary: null,
  hover: null,
  pixel: true,
  pixelSize: 3,
  set: (k, v) => set({ [k]: v } as Partial<SimStore>),
  setSelection: (selection) => set({ selection }),
  setSpeed: (speed) => set({ speed: Math.min(4, Math.max(0.1, speed)) }),
  setViewMode: (viewMode) => set({ viewMode }),
  setMode: (mode) => {
    const s = get();
    if (mode === s.mode) return;
    if (mode === 'edit') {
      sim.pause();
      set({ mode, selection: null, topology: materializeMacs(s.topology), linkStart: null });
      return;
    }
    if (s.dirty) {
      try {
        sim.load(s.topology, null, { fit: false });
      } catch (e) {
        get().showToast(`Can't simulate yet: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    set({ mode, selection: null, linkStart: null });
  },
  setLod: (lod) => {
    if (get().lod !== lod) set({ lod });
  },
  setLogFilter: (f) => set({ logFilter: { ...get().logFilter, ...f } }),
  focusNode: (nodeId) => set({ focus: { nodeId, n: (get().focus?.n ?? 0) + 1 }, selection: { kind: 'node', id: nodeId } }),
  editTopology: (fn) => {
    const topology = fn(get().topology);
    set({ topology, dirty: true, presetId: null });
    scheduleAutosave(topology);
  },
  showToast: (text) => set({ toast: { text, n: (get().toast?.n ?? 0) + 1 } }),
  setLinkStart: (linkStart) => set({ linkStart }),
}));

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleAutosave(t: TopologyJson): void {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => autosave(t), 500);
}

export class SimController {
  engine: Engine;
  /** Frames currently on a wire, keyed by packet id. */
  readonly inFlight = new Map<string, TxEvent>();
  /** Recent tx events by packet id, for the inspector. */
  readonly packets = new Map<string, TxEvent>();
  /** Wall time (performance.now) of the last frame seen per link, for activity flashes. */
  readonly linkActivity = new Map<string, number>();
  /** Recent drops for the renderer's burst effect (wall-clock time). */
  readonly drops: { node: string; at: number; bystander: boolean }[] = [];
  /** Recent successful deliveries (ping replies) for a sparkle effect. */
  readonly sparks: { node: string; at: number }[] = [];
  private pending: TraceEvent[] = [];
  private pendingBubbles = new Map<string, { lines: BubbleLine[]; simTime: number }>();
  private lastFlush = 0;
  private ctx: ExplainCtx = buildCtx({ version: 1, name: '', nodes: [], links: [] }, new Map());
  /** Lesson hook: return true to pause the simulation right after this event. */
  watcher: ((e: TraceEvent) => boolean) | null = null;
  onWatchHit: (() => void) | null = null;
  private stopRequested = false;
  private idleWall = 0;
  private unsubscribe: () => void = () => {};

  constructor() {
    this.engine = new Engine({ version: 1, name: 'Empty', nodes: [], links: [] });
  }

  /** (Re)build the engine from a topology; resets sim time to 0. */
  load(topology: TopologyJson, presetId: string | null = useSim.getState().presetId, opts: { fit?: boolean; runScenario?: boolean } = {}): void {
    // Build first: if the topology cannot be instantiated, keep the current engine.
    const engine = new Engine(topology, { runScenario: opts.runScenario ?? true });
    this.unsubscribe();
    this.inFlight.clear();
    this.packets.clear();
    this.linkActivity.clear();
    this.drops.length = 0;
    this.sparks.length = 0;
    this.pending = [];
    this.pendingBubbles.clear();
    this.stopRequested = false;
    this.ctx = buildCtx(topology, this.packets);
    this.engine = engine;
    this.unsubscribe = this.engine.on((e) => this.onEvent(e));
    useSim.setState((s) => ({
      topology,
      presetId,
      engineGen: s.engineGen + 1,
      fitGen: opts.fit === false ? s.fitGen : s.fitGen + 1,
      dirty: false,
      simTime: 0,
      version: s.version + 1,
      log: [],
      highlights: {},
      bubbles: {},
      hover: null,
      playing: false,
      selection: s.selection?.kind === 'node' && topology.nodes.some((n) => n.id === s.selection!.id) ? s.selection : null,
    }));
  }

  reset(): void {
    this.load(useSim.getState().topology, undefined, { fit: false });
  }

  private onEvent(e: TraceEvent): void {
    if (e.type === 'tx') {
      this.inFlight.set(e.packetId!, e);
      this.packets.set(e.packetId!, e);
      if (this.packets.size > PACKET_INDEX_LIMIT) this.packets.delete(this.packets.keys().next().value!);
    } else if (e.type === 'drop') {
      this.drops.push({ node: e.node, at: performance.now(), bystander: e.reason === 'not-for-me' });
      if (this.drops.length > 256) this.drops.splice(0, this.drops.length - 256);
    } else if (e.type === 'rx') {
      this.inFlight.delete(e.packetId!);
      this.linkActivity.set(e.link, performance.now());
    } else if (e.type === 'app' && e.status === 'reply') {
      this.sparks.push({ node: e.node, at: performance.now() });
      if (this.sparks.length > 64) this.sparks.shift();
    }
    this.pending.push(e);
    this.narrate(e);
    if (this.watcher?.(e)) this.stopRequested = true;
  }

  explain(e: TraceEvent) {
    return explain(e, this.ctx);
  }

  get explainCtx(): ExplainCtx {
    return this.ctx;
  }

  private narrate(e: TraceEvent): void {
    if (!e.node || e.type === 'tx' || e.type === 'rx') return;
    const x = explain(e, this.ctx);
    if (x.weight !== 'key') return;
    const line: BubbleLine = { say: x.say, tone: x.tone };
    if (x.concept) line.concept = x.concept;
    const cur = this.pendingBubbles.get(e.node) ?? (() => {
      const b = useSim.getState().bubbles[e.node];
      return b && b.simTime === e.time ? { lines: [...b.lines], simTime: b.simTime } : undefined;
    })();
    if (cur && cur.simTime === e.time) {
      if (!cur.lines.some((l) => l.say === line.say)) cur.lines.push(line);
      if (cur.lines.length > 3) cur.lines.splice(0, cur.lines.length - 3);
      this.pendingBubbles.set(e.node, cur);
    } else {
      this.pendingBubbles.set(e.node, { lines: [line], simTime: e.time });
    }
  }

  play(): void {
    useSim.setState({ playing: true });
  }

  pause(): void {
    this.flush();
    useSim.setState({ playing: false });
  }

  /** Advance one engine event (for single-stepping). */
  stepEvent(): void {
    this.pause();
    // Skip pure bookkeeping (tx-done) so each click shows something meaningful.
    for (let i = 0; i < 50; i++) {
      const ev = this.engine.step();
      if (!ev || this.pending.length || this.stopRequested) break;
    }
    this.flush();
    if (this.stopRequested) {
      this.stopRequested = false;
      this.onWatchHit?.();
    }
  }

  /** Called every animation frame with the wall-clock delta in seconds. */
  tick(dtWall: number): void {
    const { playing, speed } = useSim.getState();
    if (!playing) return;
    const e = this.engine;
    let target = e.now + dtWall * speed * BASE_NS_PER_SEC;
    if (this.inFlight.size === 0) {
      this.idleWall += dtWall;
      const next = e.nextEventTime();
      target = e.now + dtWall * speed * Math.max(BASE_NS_PER_SEC, IDLE_NS_PER_SEC);
      if (next !== undefined && this.idleWall > IDLE_PAUSE_WALL && next - e.now <= IDLE_SKIP_MAX) target = Math.max(target, next);
      else if (next !== undefined && target > next) target = next; // stop exactly at the next event, then slow down
    } else {
      this.idleWall = 0;
    }
    // Step event by event so a lesson can stop exactly at the moment it is waiting for.
    const t = Math.round(target);
    for (let next = e.peekNext(); next && next.time <= t; next = e.peekNext()) {
      e.step();
      if (this.stopRequested) break;
    }
    if (this.stopRequested) {
      this.stopRequested = false;
      this.pause();
      this.onWatchHit?.();
      return;
    }
    e.runUntil(t);
    this.flush(false);
  }

  /** Push batched events into the store. While playing this is throttled (~15 Hz) so React
   * work stays small; the renderer reads in-flight frames directly every frame. */
  flush(force = true): void {
    const wall = performance.now();
    if (!force && wall - this.lastFlush < 66) return;
    this.lastFlush = wall;
    const evs = this.pending;
    const simTime = this.engine.now;
    if (!evs.length) {
      if (useSim.getState().simTime !== simTime) useSim.setState({ simTime });
      return;
    }
    this.pending = [];
    const now = wall;
    useSim.setState((s) => {
      let log = s.log.concat(evs);
      if (log.length > LOG_LIMIT) log = log.slice(log.length - LOG_LIMIT);
      let highlights = s.highlights;
      const tableEvs = evs.filter((e) => e.type === 'table');
      if (tableEvs.length) {
        highlights = { ...highlights };
        for (const t of tableEvs) if (t.type === 'table') highlights[`${t.node}|${t.table}|${t.iface ?? ''}|${t.key}`] = { op: t.op, at: now };
        // forget old highlights
        for (const k of Object.keys(highlights)) if (now - highlights[k]!.at > 4000) delete highlights[k];
      }
      let bubbles = s.bubbles;
      if (this.pendingBubbles.size) {
        bubbles = { ...bubbles };
        for (const [node, b] of this.pendingBubbles) bubbles[node] = { lines: b.lines, simTime: b.simTime, at: now, n: (bubbles[node]?.n ?? 0) + 1 };
        this.pendingBubbles.clear();
      }
      return { log, simTime, version: s.version + 1, highlights, bubbles };
    });
  }

  // ---- commands (all user actions go through here)

  ping(hostId: string, dst: string, count = 4): void {
    this.command(() => this.engine.ping(hostId, dst, { count }));
  }

  traceroute(hostId: string, dst: string): void {
    this.command(() => this.engine.traceroute(hostId, dst));
  }

  private command(run: () => void): void {
    try {
      run();
    } catch (e) {
      useSim.getState().showToast(e instanceof Error ? e.message : String(e));
      return;
    }
    this.flush();
    this.play();
  }

  state(nodeId: string): DeviceState | undefined {
    return this.engine.getState(nodeId);
  }
}

export const sim = new SimController();
