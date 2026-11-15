/** Instantiate runtime devices and links from a TopologyJson. */
import type { Engine } from '../core/Engine';
import { MS } from '../core/time';
import type { Device, PortInit } from '../devices/Device';
import { Host } from '../devices/Host';
import { Router } from '../devices/Router';
import { Switch } from '../devices/Switch';
import { DEFAULT_LINK_BANDWIDTH_MBPS, DEFAULT_LINK_LATENCY_MS, type LinkEndJson, type NodeJson, type TopologyJson } from '../model/topology';
import { parseCidr } from '../protocols/addr';

export interface LinkRuntime {
  id: string;
  a: LinkEndJson;
  b: LinkEndJson;
  latencyNs: number;
  bandwidthBps: number;
}

/** Deterministic locally-administered MAC: 02:00:00:NN:NN:II (node index, iface index). */
export function generatedMac(nodeIndex: number, ifaceIndex: number): string {
  const b = [0x02, 0, 0, ((nodeIndex + 1) >> 8) & 0xff, (nodeIndex + 1) & 0xff, (ifaceIndex + 1) & 0xff];
  return b.map((x) => x.toString(16).padStart(2, '0')).join(':');
}

function portsOf(n: NodeJson, nodeIndex: number): PortInit[] {
  return n.interfaces.map((i, k) => {
    const p: PortInit = { id: i.id, mac: (i.mac ?? generatedMac(nodeIndex, k)).toLowerCase() };
    if (i.ip && n.type !== 'switch') {
      const { ip, prefix } = parseCidr(i.ip);
      p.ip = { addr: ip, prefix };
    }
    return p;
  });
}

export function buildDevices(engine: Engine, topo: TopologyJson): { devices: Map<string, Device>; links: Map<string, LinkRuntime> } {
  const devices = new Map<string, Device>();
  topo.nodes.forEach((n, idx) => {
    const ports = portsOf(n, idx);
    let d: Device;
    switch (n.type) {
      case 'host':
        d = new Host(engine, n.id, n.name, ports, n.gateway || null);
        break;
      case 'switch':
        d = new Switch(engine, n.id, n.name, ports);
        break;
      case 'router':
        d = new Router(
          engine,
          n.id,
          n.name,
          ports,
          n.staticRoutes.map((r) => {
            const { ip, prefix } = parseCidr(r.prefix);
            return { network: ip, prefix, nextHop: r.nextHop };
          }),
        );
        break;
    }
    if (devices.has(n.id)) throw new Error(`Duplicate node id ${n.id}`);
    devices.set(n.id, d);
  });

  const links = new Map<string, LinkRuntime>();
  for (const l of topo.links) {
    for (const end of [l.a, l.b]) {
      const port = devices.get(end.node)?.ports.get(end.iface);
      if (!port) throw new Error(`Link ${l.id}: ${end.node}.${end.iface} does not exist`);
      if (port.linkId) throw new Error(`Link ${l.id}: ${end.node}.${end.iface} is already connected to ${port.linkId}`);
      port.linkId = l.id;
    }
    links.set(l.id, {
      id: l.id,
      a: l.a,
      b: l.b,
      latencyNs: Math.round((l.latencyMs ?? DEFAULT_LINK_LATENCY_MS) * MS),
      bandwidthBps: (l.bandwidthMbps ?? DEFAULT_LINK_BANDWIDTH_MBPS) * 1e6,
    });
  }
  return { devices, links };
}
