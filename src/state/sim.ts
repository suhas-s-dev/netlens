/**
 * Bridge between the pure engine and the UI.
 *
 * `sim` (SimController) owns the Engine instance and the playback clock. It subscribes to
 * trace events, keeps the set of frames currently on a wire (read every animation frame by
 * the renderer, without React), and flushes batched updates into the zustand store.
 * UI code never mutates the engine: it calls controller commands.
 */
import { create } from 'zustand';
import { Engine, MS, SEC, type DeviceState, type TopologyJson, type TraceEvent, type TxEvent } from '../engine';

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

export interface SimStore {
  topology: TopologyJson;
  presetId: string | null;
  engineGen: number;
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
  setSelection(s: Selection | null): void;
  setSpeed(s: number): void;
  setViewMode(v: 'perspective' | 'iso'): void;
  setMode(m: 'sim' | 'edit'): void;
  setLod(l: 'far' | 'mid' | 'near'): void;
  setLogFilter(f: Partial<SimStore['logFilter']>): void;
  focusNode(id: string): void;
}

export const useSim = create<SimStore>((set, get) => ({
  topology: { version: 1, name: 'Empty', nodes: [], links: [] },
  presetId: null,
  engineGen: 0,
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
  setSelection: (selection) => set({ selection }),
  setSpeed: (speed) => set({ speed: Math.min(4, Math.max(0.1, speed)) }),
  setViewMode: (viewMode) => set({ viewMode }),
  setMode: (mode) => {
    if (mode === 'edit') sim.pause();
    set({ mode, selection: null });
  },
  setLod: (lod) => {
    if (get().lod !== lod) set({ lod });
  },
  setLogFilter: (f) => set({ logFilter: { ...get().logFilter, ...f } }),
  focusNode: (nodeId) => set({ focus: { nodeId, n: (get().focus?.n ?? 0) + 1 }, selection: { kind: 'node', id: nodeId } }),
}));

export class SimController {
  engine: Engine;
  /** Frames currently on a wire, keyed by packet id. */
  readonly inFlight = new Map<string, TxEvent>();
  /** Recent tx events by packet id, for the inspector. */
  readonly packets = new Map<string, TxEvent>();
  /** Wall time (performance.now) of the last frame seen per link, for activity flashes. */
  readonly linkActivity = new Map<string, number>();
  private pending: TraceEvent[] = [];
  private idleWall = 0;
  private unsubscribe: () => void = () => {};

  constructor() {
    this.engine = new Engine({ version: 1, name: 'Empty', nodes: [], links: [] });
  }

  /** (Re)build the engine from a topology; resets sim time to 0. */
  load(topology: TopologyJson, presetId: string | null = useSim.getState().presetId, runScenario = true): void {
    this.unsubscribe();
    this.inFlight.clear();
    this.packets.clear();
    this.linkActivity.clear();
    this.pending = [];
    this.engine = new Engine(topology, { runScenario });
    this.unsubscribe = this.engine.on((e) => this.onEvent(e));
    useSim.setState((s) => ({
      topology,
      presetId,
      engineGen: s.engineGen + 1,
      simTime: 0,
      version: s.version + 1,
      log: [],
      highlights: {},
      playing: false,
      selection: s.selection?.kind === 'node' && topology.nodes.some((n) => n.id === s.selection!.id) ? s.selection : null,
    }));
  }

  reset(): void {
    this.load(useSim.getState().topology);
  }

  private onEvent(e: TraceEvent): void {
    if (e.type === 'tx') {
      this.inFlight.set(e.packetId!, e);
      this.packets.set(e.packetId!, e);
      if (this.packets.size > PACKET_INDEX_LIMIT) this.packets.delete(this.packets.keys().next().value!);
    } else if (e.type === 'rx') {
      this.inFlight.delete(e.packetId!);
      this.linkActivity.set(e.link, performance.now());
    }
    this.pending.push(e);
  }

  play(): void {
    useSim.setState({ playing: true });
  }

  pause(): void {
    useSim.setState({ playing: false });
  }

  /** Advance one engine event (for single-stepping). */
  stepEvent(): void {
    this.pause();
    // Skip pure bookkeeping (tx-done) so each click shows something meaningful.
    for (let i = 0; i < 50; i++) {
      const ev = this.engine.step();
      if (!ev || this.pending.length) break;
    }
    this.flush();
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
    e.runUntil(Math.round(target));
    this.flush();
  }

  flush(): void {
    const evs = this.pending;
    const simTime = this.engine.now;
    if (!evs.length) {
      if (useSim.getState().simTime !== simTime) useSim.setState({ simTime });
      return;
    }
    this.pending = [];
    const now = performance.now();
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
      return { log, simTime, version: s.version + 1, highlights };
    });
  }

  // ---- commands (all user actions go through here)

  ping(hostId: string, dst: string, count = 4): void {
    this.engine.ping(hostId, dst, { count });
    this.flush();
    this.play();
  }

  traceroute(hostId: string, dst: string): void {
    this.engine.traceroute(hostId, dst);
    this.flush();
    this.play();
  }

  state(nodeId: string): DeviceState | undefined {
    return this.engine.getState(nodeId);
  }
}

export const sim = new SimController();
