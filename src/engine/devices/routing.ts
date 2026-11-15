/** Routing table + longest-prefix match (RFC 1812 5.2.4.3). */
import { inSubnet, networkOf, type Ipv4 } from '../protocols/addr';

export type RouteType = 'connected' | 'static';

/** Lower wins when prefixes are equal length (Cisco-style administrative distance). */
export const ADMIN_DISTANCE: Record<RouteType, number> = { connected: 0, static: 1 };

export interface Route {
  network: Ipv4;
  prefix: number;
  /** null = directly connected (next hop is the destination itself). */
  nextHop: Ipv4 | null;
  iface: string;
  type: RouteType;
  /** Static routes whose next hop is not on a connected subnet are inactive. */
  active: boolean;
}

export function cidr(r: Pick<Route, 'network' | 'prefix'>): string {
  return `${r.network}/${r.prefix}`;
}

export interface LpmResult {
  best: Route | undefined;
  /** All active matching routes, best first. */
  matches: Route[];
}

/** Rank matching routes: longest prefix, then lowest admin distance, then table order. */
export function longestPrefixMatch(routes: readonly Route[], dst: Ipv4): LpmResult {
  const matches = routes
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.active && inSubnet(dst, r.network, r.prefix))
    .sort((a, b) => b.r.prefix - a.r.prefix || ADMIN_DISTANCE[a.r.type] - ADMIN_DISTANCE[b.r.type] || a.i - b.i)
    .map(({ r }) => r);
  return { best: matches[0], matches };
}

export interface IfaceAddr {
  id: string;
  addr: Ipv4;
  prefix: number;
}

export interface StaticRouteSpec {
  network: Ipv4;
  prefix: number;
  nextHop: Ipv4;
}

/** Build a table: one connected route per addressed interface, then static routes resolved
 * to an egress interface by finding the connected subnet that contains their next hop.
 * Recursive next-hop resolution is not supported in the MVP. */
export function buildRoutingTable(ifaces: readonly IfaceAddr[], statics: readonly StaticRouteSpec[]): Route[] {
  const connected: Route[] = ifaces.map((i) => ({
    network: networkOf(i.addr, i.prefix),
    prefix: i.prefix,
    nextHop: null,
    iface: i.id,
    type: 'connected',
    active: true,
  }));
  const stat: Route[] = statics.map((s) => {
    const via = connected.find((c) => inSubnet(s.nextHop, c.network, c.prefix));
    return {
      network: networkOf(s.network, s.prefix),
      prefix: s.prefix,
      nextHop: s.nextHop,
      iface: via?.iface ?? '',
      type: 'static',
      active: via !== undefined,
    };
  });
  return [...connected, ...stat];
}
