/**
 * Deterministic discrete-event network simulator.
 *
 * - All state changes happen inside events popped from a (time, seq)-ordered queue.
 * - Randomness only comes from the seeded RNG.
 * => the same topology + the same commands at the same sim times = the same trace.
 *
 * The renderer/UI subscribe via `on()` and read state via `getState()`; they drive the sim
 * only through commands (`ping`, `traceroute`, ...) and the clock (`step`, `runUntil`).
 */
import type { Device, Port, SendMeta } from '../devices/Device';
import { Host, type PingOptions, type TracerouteOptions } from '../devices/Host';
import type { DeviceState } from '../devices/state';
import type { Frame } from '../model/frame';
import { encodeFrame } from '../model/frame';
import type { TopologyJson } from '../model/topology';
import { isValidIp } from '../protocols/addr';
import { classifyFrame, summarizeFrame } from '../protocols/describe';
import { wireBytes } from '../protocols/ethernet';
import type { EthernetFrame } from '../protocols/types';
import type { TraceEvent, TraceInput } from '../trace/events';
import { buildDevices, type LinkRuntime } from '../topology/build';
import { EventQueue, type ScheduledEvent } from './EventQueue';
import { Rng } from './Rng';
import { formatDuration, MS, SEC } from './time';

export interface EngineOptions {
  seed?: number;
  /** Schedule the topology's scripted scenario steps (default true). */
  runScenario?: boolean;
}

export type TraceListener = (e: TraceEvent) => void;

export class Engine {
  now = 0;
  readonly rng: Rng;
  readonly devices: Map<string, Device>;
  readonly links: Map<string, LinkRuntime>;
  private queue = new EventQueue();
  private listeners = new Set<TraceListener>();
  private traceSeq = 0;
  private frameSeq = 0;
  private flowSeq = 0;
  private eventsProcessed = 0;

  constructor(
    readonly topology: TopologyJson,
    opts: EngineOptions = {},
  ) {
    this.rng = new Rng(opts.seed ?? topology.seed ?? 1);
    const built = buildDevices(this, topology);
    this.devices = built.devices;
    this.links = built.links;
    if (opts.runScenario !== false) this.scheduleScenario();
  }

  // ---------------------------------------------------------------- subscription

  on(listener: TraceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(input: TraceInput): void {
    const ev = { ...input, seq: ++this.traceSeq, time: this.now } as TraceEvent;
    for (const l of this.listeners) l(ev);
  }

  // ---------------------------------------------------------------- clock

  /** Schedule `run` after `delayNs` of sim time. */
  schedule(delayNs: number, label: string, run: () => void, nodeId?: string): ScheduledEvent {
    return this.queue.push(this.now + Math.max(0, Math.round(delayNs)), label, run, nodeId);
  }

  nextEventTime(): number | undefined {
    return this.queue.peek()?.time;
  }

  peekNext(): ScheduledEvent | undefined {
    return this.queue.peek();
  }

  get pendingEvents(): number {
    return this.queue.size;
  }

  get processed(): number {
    return this.eventsProcessed;
  }

  /** Process exactly one event. Returns it, or undefined if the queue is empty. */
  step(): ScheduledEvent | undefined {
    const ev = this.queue.pop();
    if (!ev) return undefined;
    this.now = ev.time;
    this.eventsProcessed++;
    ev.run();
    return ev;
  }

  /** Process every event with time <= t, then advance the clock to t. */
  runUntil(t: number): number {
    let n = 0;
    for (let next = this.queue.peek(); next && next.time <= t; next = this.queue.peek()) {
      this.step();
      n++;
    }
    if (t > this.now) this.now = t;
    return n;
  }

  runFor(dt: number): number {
    return this.runUntil(this.now + dt);
  }

  /** Run until the queue is empty or `limitNs` of sim time is reached. */
  runUntilIdle(limitNs = 3600 * SEC): number {
    let n = 0;
    for (let next = this.queue.peek(); next && next.time <= limitNs; next = this.queue.peek()) {
      this.step();
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- ids

  newFrameId(): string {
    return `p${++this.frameSeq}`;
  }

  newFlowId(): string {
    return `f${++this.flowSeq}`;
  }

  // ---------------------------------------------------------------- link layer

  /** Put a frame onto the port's link (or its transmit queue). */
  transmit(dev: Device, port: Port, eth: EthernetFrame, meta: SendMeta): Frame | undefined {
    const frame: Frame = { id: this.newFrameId(), flowId: meta.flowId, eth };
    if (meta.parentId !== undefined) frame.parentId = meta.parentId;
    if (!port.linkId) {
      this.emit({ type: 'drop', node: dev.id, reason: 'no-link', iface: port.id, text: `${dev.name} ${dev.portLabel(port)} is not connected; frame dropped`, packetId: frame.id, flowId: frame.flowId });
      return undefined;
    }
    if (port.txBusy) {
      if (port.txQueue.length >= port.maxQueue) {
        this.emit({ type: 'drop', node: dev.id, reason: 'queue-full', iface: port.id, text: `${dev.name} ${dev.portLabel(port)} transmit queue full (${port.maxQueue}); frame tail-dropped`, packetId: frame.id, flowId: frame.flowId });
        return undefined;
      }
      port.txQueue.push(frame);
      return frame;
    }
    this.startTx(dev, port, frame);
    return frame;
  }

  private startTx(dev: Device, port: Port, frame: Frame): void {
    const link = this.links.get(port.linkId!)!;
    const peerEnd = link.a.node === dev.id && link.a.iface === port.id ? link.b : link.a;
    const peer = this.devices.get(peerEnd.node)!;
    const peerPort = peer.ports.get(peerEnd.iface)!;
    const size = encodeFrame(frame.eth).bytes.length;
    const wire = wireBytes(size);
    const ser = Math.max(1, Math.round((wire * 8 * SEC) / link.bandwidthBps));
    const txStart = this.now;
    const txEnd = txStart + ser;
    const arrive = txEnd + link.latencyNs;
    port.txBusy = true;
    this.emit({
      type: 'tx',
      node: dev.id,
      iface: port.id,
      link: link.id,
      toNode: peer.id,
      toIface: peerPort.id,
      frame,
      cls: classifyFrame(frame.eth),
      size,
      wireSize: wire,
      txStart,
      txEnd,
      arrive,
      packetId: frame.id,
      flowId: frame.flowId,
      text: `${dev.name} ${dev.portLabel(port)} → ${peer.name} ${peer.portLabel(peerPort)}: ${summarizeFrame(frame.eth)} [${size} B, ${formatDuration(ser)} serialization + ${formatDuration(link.latencyNs)} propagation]`,
    });
    this.queue.push(txEnd, `${dev.name} ${port.id} tx done`, () => {
      port.txBusy = false;
      const next = port.txQueue.shift();
      if (next) this.startTx(dev, port, next);
    }, dev.id);
    this.queue.push(arrive, `${peer.name} ${peerPort.id} rx ${frame.id}`, () => {
      this.emit({ type: 'rx', node: peer.id, iface: peerPort.id, link: link.id, frame, packetId: frame.id, flowId: frame.flowId, text: `${peer.name} ${peer.portLabel(peerPort)} received ${summarizeFrame(frame.eth)}` });
      peer.receive(peerPort, frame);
    }, peer.id);
  }

  // ---------------------------------------------------------------- commands

  private host(id: string, dst: string): Host {
    if (!isValidIp(dst)) throw new Error(`Invalid destination IPv4 address: ${dst}`);
    const d = this.devices.get(id);
    if (!(d instanceof Host)) throw new Error(`${id} is not a host`);
    return d;
  }

  /** Start a ping now. Returns the session id. */
  ping(hostId: string, dst: string, opts?: PingOptions): string {
    return this.host(hostId, dst).startPing(dst, opts);
  }

  traceroute(hostId: string, dst: string, opts?: TracerouteOptions): string {
    return this.host(hostId, dst).startTraceroute(dst, opts);
  }

  private scheduleScenario(): void {
    for (const s of this.topology.scenario ?? []) {
      // Skip steps that no longer make sense (e.g. the host was deleted in the editor).
      if (!(this.devices.get(s.node) instanceof Host) || !isValidIp(s.dst)) continue;
      this.queue.push(s.at * MS, `scenario: ${s.action} ${s.node} → ${s.dst}`, () => {
        if (s.action === 'ping') {
          const o: PingOptions = {};
          if (s.count !== undefined) o.count = s.count;
          if (s.intervalMs !== undefined) o.intervalNs = s.intervalMs * MS;
          if (s.ttl !== undefined) o.ttl = s.ttl;
          this.ping(s.node, s.dst, o);
        } else {
          const o: TracerouteOptions = {};
          if (s.maxHops !== undefined) o.maxHops = s.maxHops;
          this.traceroute(s.node, s.dst, o);
        }
      }, s.node);
    }
  }

  // ---------------------------------------------------------------- state

  getState(nodeId: string): DeviceState | undefined {
    return this.devices.get(nodeId)?.getState();
  }

  getAllStates(): DeviceState[] {
    return [...this.devices.values()].map((d) => d.getState());
  }
}
