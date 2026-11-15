import { Engine } from '../core/Engine';
import type { HostJson, LinkJson, RouterJson, SwitchJson, TopologyJson } from '../model/topology';
import type { TraceEvent } from '../trace/events';

export function host(id: string, ip: string, gateway?: string): HostJson {
  const h: HostJson = { id, name: id.toUpperCase(), type: 'host', position: { x: 0, y: 0 }, interfaces: [{ id: 'eth0', ip }] };
  if (gateway) h.gateway = gateway;
  return h;
}

export function sw(id: string, ports: number): SwitchJson {
  return { id, name: id.toUpperCase(), type: 'switch', position: { x: 0, y: 0 }, interfaces: Array.from({ length: ports }, (_, i) => ({ id: String(i + 1) })) };
}

export function router(id: string, ifaces: Record<string, string>, staticRoutes: RouterJson['staticRoutes'] = []): RouterJson {
  return { id, name: id.toUpperCase(), type: 'router', position: { x: 0, y: 0 }, interfaces: Object.entries(ifaces).map(([k, ip]) => ({ id: k, ip })), staticRoutes };
}

let linkN = 0;
export function link(a: string, b: string, extra: Partial<LinkJson> = {}): LinkJson {
  const [an, ai] = a.split('.') as [string, string];
  const [bn, bi] = b.split('.') as [string, string];
  return { id: `l${++linkN}`, a: { node: an, iface: ai }, b: { node: bn, iface: bi }, ...extra };
}

export function topo(nodes: TopologyJson['nodes'], links: LinkJson[]): TopologyJson {
  return { version: 1, name: 'test', nodes, links };
}

/** Single LAN: h1..hN (10.0.0.(i)/24) on one switch. */
export function lanTopology(n = 3): TopologyJson {
  linkN = 0;
  const hosts = Array.from({ length: n }, (_, i) => host(`h${i + 1}`, `10.0.0.${i + 1}/24`));
  return topo([...hosts, sw('sw1', n + 1)], hosts.map((h, i) => link(`${h.id}.eth0`, `sw1.${i + 1}`)));
}

/** h1 (10.0.1.10) - r1 - r2 - r3 - h2 (10.0.3.10), static routes both ways. */
export function chainTopology(): TopologyJson {
  linkN = 0;
  return topo(
    [
      host('h1', '10.0.1.10/24', '10.0.1.1'),
      router('r1', { eth0: '10.0.1.1/24', eth1: '10.0.12.1/30' }, [{ prefix: '0.0.0.0/0', nextHop: '10.0.12.2' }]),
      router('r2', { eth0: '10.0.12.2/30', eth1: '10.0.23.1/30' }, [
        { prefix: '10.0.1.0/24', nextHop: '10.0.12.1' },
        { prefix: '10.0.3.0/24', nextHop: '10.0.23.2' },
      ]),
      router('r3', { eth0: '10.0.23.2/30', eth1: '10.0.3.1/24' }, [{ prefix: '10.0.0.0/16', nextHop: '10.0.23.1' }]),
      host('h2', '10.0.3.10/24', '10.0.3.1'),
    ],
    [link('h1.eth0', 'r1.eth0'), link('r1.eth1', 'r2.eth0'), link('r2.eth1', 'r3.eth0'), link('r3.eth1', 'h2.eth0')],
  );
}

export function record(engine: Engine): TraceEvent[] {
  const out: TraceEvent[] = [];
  engine.on((e) => out.push(e));
  return out;
}

export function make(t: TopologyJson, seed = 1): { engine: Engine; events: TraceEvent[] } {
  const engine = new Engine(t, { seed });
  return { engine, events: record(engine) };
}

export function texts(events: TraceEvent[], types?: TraceEvent['type'][]): string[] {
  return events.filter((e) => !types || types.includes(e.type)).map((e) => e.text);
}

export function appLines(events: TraceEvent[]): string[] {
  return events.filter((e) => e.type === 'app' && e.status !== 'sent').map((e) => e.text);
}

/** Compact, stable rendering of a trace for snapshots. */
export function formatTrace(events: TraceEvent[]): string {
  return events
    .filter((e) => e.type !== 'rx')
    .map((e) => `${(e.time / 1e6).toFixed(6).padStart(14)}ms ${e.type.padEnd(8)} ${e.text}`)
    .join('\n');
}
