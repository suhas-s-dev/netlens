import type { ReactNode } from 'react';
import { formatDuration, type ArpRow, type DeviceState, type MacRow, type RouteRow } from '../engine';
import { sim, useSim, type Highlight } from '../state/sim';

const FRESH_MS = 3000;

function useHighlights(nodeId: string, table: string) {
  const all = useSim((s) => s.highlights);
  const now = performance.now();
  const out = new Map<string, Highlight>();
  const prefix = `${nodeId}|${table}|`;
  for (const [k, h] of Object.entries(all)) if (k.startsWith(prefix) && now - h.at < FRESH_MS) out.set(k.slice(prefix.length), h);
  return out;
}

/** A table row that flashes when its entry was just added / used / refreshed. */
function HRow({ hl, className = '', children }: { hl: Highlight | undefined; className?: string; children: ReactNode }) {
  // Callers key rows on the highlight time, which restarts the CSS animation on each new event.
  return (
    <tr className={`${className} ${hl ? `hl-${hl.op}` : ''}`}>
      {children}
    </tr>
  );
}

function Ghosts({ hls, present, cols }: { hls: Map<string, Highlight>; present: Set<string>; cols: number }) {
  return (
    <>
      {[...hls.entries()]
        .filter(([k, h]) => h.op === 'remove' && !present.has(k))
        .map(([k]) => (
          <tr key={`ghost-${k}`} className="removed">
            <td colSpan={cols}>{k.split('|').filter(Boolean).join(' ')} — removed</td>
          </tr>
        ))}
    </>
  );
}

function ArpTable({ nodeId, rows, showIface }: { nodeId: string; rows: ArpRow[]; showIface: boolean }) {
  const hls = useHighlights(nodeId, 'arp');
  const present = new Set(rows.map((r) => `${r.iface}|${r.ip}`));
  return (
    <table className="tbl">
      <thead>
        <tr>
          {showIface && <th>If</th>}
          <th>IP</th>
          <th>MAC</th>
          <th>Expires</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && !hls.size && (
          <tr>
            <td colSpan={4} className="dim">
              empty
            </td>
          </tr>
        )}
        {rows.map((r) => {
          const k = `${r.iface}|${r.ip}`;
          const hl = hls.get(k);
          return (
            <HRow key={`${k}-${hl?.at ?? 0}`} hl={hl} className={r.state}>
              {showIface && <td>{r.iface}</td>}
              <td>{r.ip}</td>
              <td>{r.mac ?? `(incomplete, ${r.queued} queued)`}</td>
              <td className="dim">{r.state === 'incomplete' ? `retry ${formatDuration(r.expiresIn)}` : formatDuration(r.expiresIn)}</td>
            </HRow>
          );
        })}
        <Ghosts hls={hls} present={present} cols={showIface ? 4 : 3} />
      </tbody>
    </table>
  );
}

function MacTable({ nodeId, rows }: { nodeId: string; rows: MacRow[] }) {
  const hls = useHighlights(nodeId, 'mac');
  const present = new Set(rows.map((r) => `${r.port}|${r.mac}`));
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Port</th>
          <th>MAC</th>
          <th>Ages out in</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && !hls.size && (
          <tr>
            <td colSpan={3} className="dim">
              empty: every unicast frame will be flooded
            </td>
          </tr>
        )}
        {rows.map((r) => {
          const k = `${r.port}|${r.mac}`;
          const hl = hls.get(k);
          return (
            <HRow key={`${k}-${hl?.at ?? 0}`} hl={hl}>
              <td>{r.port}</td>
              <td>{r.mac}</td>
              <td className="dim">{formatDuration(r.expiresIn)}</td>
            </HRow>
          );
        })}
        <Ghosts hls={hls} present={present} cols={3} />
      </tbody>
    </table>
  );
}

function RouteTable({ rows }: { rows: RouteRow[] }) {
  // Show in LPM order: longest prefix first.
  const sorted = [...rows].sort((a, b) => Number(b.prefix.split('/')[1]) - Number(a.prefix.split('/')[1]));
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Prefix</th>
          <th>Next hop</th>
          <th>If</th>
          <th>Type</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((r) => (
          <tr key={`${r.prefix}-${r.nextHop}-${r.type}`} className={r.active ? '' : 'inactive'} title={r.active ? '' : 'Inactive: next hop is not on a connected subnet'}>
            <td>{r.prefix}</td>
            <td>{r.nextHop ?? <span className="dim">direct</span>}</td>
            <td>{r.iface || '—'}</td>
            <td>
              <span className={`pill ${r.type}`}>{r.type === 'connected' ? 'C' : 'S'}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Ports({ st }: { st: DeviceState }) {
  const topology = useSim((s) => s.topology);
  const peerOf = (linkId?: string, self?: string) => {
    const l = topology.links.find((x) => x.id === linkId);
    if (!l) return null;
    const end = l.a.node === st.id && l.a.iface === self ? l.b : l.a;
    const n = topology.nodes.find((x) => x.id === end.node);
    return n ? `${n.name} ${n.type === 'switch' ? 'p' : ''}${end.iface}` : null;
  };
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>{st.kind === 'switch' ? 'Port' : 'If'}</th>
          <th>MAC</th>
          {st.kind !== 'switch' && <th>IP</th>}
          <th>Peer</th>
        </tr>
      </thead>
      <tbody>
        {st.ports.map((p) => (
          <tr key={p.id} className={p.linkId ? '' : 'inactive'}>
            <td>{p.id}</td>
            <td>{p.mac}</td>
            {st.kind !== 'switch' && <td>{p.ip ?? '—'}</td>}
            <td>
              {peerOf(p.linkId, p.id) ?? <span className="dim">not connected</span>}
              {p.queued > 0 && <span className="pill"> {p.queued} queued</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DevicePanel({ nodeId }: { nodeId: string }) {
  useSim((s) => s.version);
  useSim((s) => s.engineGen);
  const focusNode = useSim((s) => s.focusNode);
  const st = sim.state(nodeId);
  if (!st) return <div className="empty">Device not found.</div>;
  return (
    <div className="panel">
      <div className="panel-title">
        <h3>{st.name}</h3>
        <span className="kind">{st.kind}</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => focusNode(nodeId)} title="Fly the camera to this device">
          Fly to
        </button>
      </div>
      <h4>{st.kind === 'switch' ? 'Ports' : 'Interfaces'}</h4>
      <Ports st={st} />
      {st.kind === 'host' && (
        <>
          <div className="hint">Default gateway: {st.gateway ?? 'none'}</div>
          <h4>ARP cache</h4>
          <ArpTable nodeId={nodeId} rows={st.arp} showIface={false} />
          {st.sessions.length > 0 && (
            <>
              <h4>Terminal</h4>
              <div className="term" ref={(el) => {
                  if (el) el.scrollTop = el.scrollHeight;
                }}>
                {st.sessions.map((s) => (
                  <div key={s.id}>
                    {s.lines.map((l, i) => (
                      <div key={i} className={/Unreachable|timeout|exceeded|!H|!N/.test(l) ? 'err' : /bytes from|complete/.test(l) ? 'ok' : ''}>
                        {l}
                      </div>
                    ))}
                    {!s.done && <div className="dim">…</div>}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
      {st.kind === 'switch' && (
        <>
          <h4>MAC address table</h4>
          <MacTable nodeId={nodeId} rows={st.mac} />
          <div className="hint">Entries age out after {formatDuration(st.agingNs)} without traffic from that address.</div>
        </>
      )}
      {st.kind === 'router' && (
        <>
          <h4>Routing table</h4>
          <RouteTable rows={st.routes} />
          <h4>ARP cache</h4>
          <ArpTable nodeId={nodeId} rows={st.arp} showIface />
        </>
      )}
    </div>
  );
}
