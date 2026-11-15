import type { ReactNode } from 'react';
import { formatDuration, type ArpRow, type DeviceState, type MacRow, type RouteRow, type TcpRow } from '../engine';
import { COLUMN_NOTES } from '../learn/fieldNotes';
import { sim, useSim, type Highlight } from '../state/sim';
import { ConceptCard, Q } from './learn/ConceptCard';

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
          {showIface && <th title={COLUMN_NOTES['arp.if']}>If</th>}
          <th title={COLUMN_NOTES['arp.ip']}>IP</th>
          <th title={COLUMN_NOTES['arp.mac']}>MAC</th>
          <th title={COLUMN_NOTES['arp.expires']}>Expires</th>
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
          <th title={COLUMN_NOTES['mac.port']}>Port</th>
          <th title={COLUMN_NOTES['mac.mac']}>MAC</th>
          <th title={COLUMN_NOTES['mac.expires']}>Ages out in</th>
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
          <th title={COLUMN_NOTES['route.prefix']}>Prefix</th>
          <th title={COLUMN_NOTES['route.nexthop']}>Next hop</th>
          <th title={COLUMN_NOTES['route.if']}>If</th>
          <th title={COLUMN_NOTES['route.type']}>Type</th>
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
          {st.kind !== 'switch' && <th title="Largest IP packet this interface sends without fragmenting">MTU</th>}
          <th>Peer</th>
        </tr>
      </thead>
      <tbody>
        {st.ports.map((p) => (
          <tr key={p.id} className={p.linkId ? '' : 'inactive'}>
            <td>{p.id}</td>
            <td>{p.mac}</td>
            {st.kind !== 'switch' && <td>{p.ip ?? '—'}</td>}
            {st.kind !== 'switch' && <td className={p.mtu !== 1500 ? '' : 'dim'}>{p.mtu}</td>}
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

const TONE_ICON: Record<string, string> = { info: '›', good: '✓', warn: '?', bad: '✕', muted: '·' };

/** The device's recent decisions, explained, newest first. */
function Activity({ nodeId }: { nodeId: string }) {
  const log = useSim((s) => s.log);
  const items = [];
  for (let i = log.length - 1; i >= 0 && items.length < 6; i--) {
    const e = log[i]!;
    if (e.node !== nodeId || e.type === 'tx' || e.type === 'rx') continue;
    const x = sim.explain(e);
    if (x.weight !== 'key') continue;
    items.push({ e, x });
  }
  if (!items.length) return <div className="hint">Nothing yet. Press Play, or send a ping from the panel on the left.</div>;
  return (
    <div className="activity">
      {items.map(({ e, x }) => (
        <div key={e.seq} className={`act tone-${x.tone}`}>
          <span className="ico">{TONE_ICON[x.tone]}</span>
          <div>
            <div>
              {x.say} {x.concept && <Q id={x.concept} />}
            </div>
            {x.why && <div className="why">Why: {x.why}</div>}
            <div className="when">t = {(e.time / 1e6).toFixed(3)} ms</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TcpTable({ nodeId, rows }: { nodeId: string; rows: TcpRow[] }) {
  const hls = useHighlights(nodeId, 'tcp');
  const present = new Set(rows.map((r) => `|${r.id}`));
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th>Remote</th>
          <th>State</th>
          <th title="Bytes sent / received">Sent / recv</th>
          <th title="Unacknowledged bytes in flight">In flight</th>
          <th title="Retransmission timeout; smoothed RTT">RTO</th>
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && ![...hls.keys()].some((k) => !present.has(k)) && (
          <tr>
            <td colSpan={5} className="dim">
              no connections
            </td>
          </tr>
        )}
        {rows.map((r) => {
          const hl = hls.get(`|${r.id}`);
          return (
            <HRow key={`${r.id}-${hl?.at ?? 0}`} hl={hl}>
              <td title={`local ${r.local}`}>{r.remote}</td>
              <td>
                <span className={`pill tcp-${r.state}`}>{r.state}</span>
              </td>
              <td>
                {r.sent} / {r.received}
              </td>
              <td>{r.unacked}</td>
              <td className="dim">
                {r.rtoMs} ms{r.srttMs !== null ? ` (rtt ${r.srttMs})` : ''}
                {r.retransmissions ? ` · ${r.retransmissions} rexmit` : ''}
              </td>
            </HRow>
          );
        })}
        <Ghosts hls={hls} present={present} cols={5} />
      </tbody>
    </table>
  );
}

const TABLE_GUIDE = {
  host: 'Its ARP cache: the IP → MAC answers it has learned. Empty means its next packet will start with an ARP broadcast.',
  switch: 'Its MAC table: which device is behind which port. Watch it fill up as frames arrive. Unknown destinations get flooded.',
  router: 'Its routing table decides where each packet goes next; its ARP cache holds the MACs of neighbours on each interface.',
} as const;

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
      <ConceptCard id={st.kind} />
      <h4>What it just did</h4>
      <Activity nodeId={nodeId} />
      <div className="hint">{TABLE_GUIDE[st.kind]}</div>
      <h4>
        {st.kind === 'switch' ? 'Ports' : 'Interfaces'} <Q id="port" />
      </h4>
      <Ports st={st} />
      {st.kind === 'host' && (
        <>
          <div className="hint">Default gateway: {st.gateway ?? 'none'}</div>
          <h4>
            ARP cache <Q id="arp-cache" />
          </h4>
          <ArpTable nodeId={nodeId} rows={st.arp} showIface={false} />
          <h4>
            TCP connections <Q id="tcp-states" />
          </h4>
          <TcpTable nodeId={nodeId} rows={st.tcp} />
          <div className="hint">
            Listening: TCP {st.listening.tcp.join(', ')} (web server), UDP {st.listening.udp.join(', ')} (echo). Any other port is closed. <Q id="port-number" />
          </div>
          {st.pmtu.length > 0 && (
            <>
              <h4>
                Path MTU cache <Q id="pmtud" />
              </h4>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Destination</th>
                    <th>Path MTU</th>
                    <th>Expires</th>
                  </tr>
                </thead>
                <tbody>
                  {st.pmtu.map((r) => (
                    <tr key={r.dst} className="hl-add">
                      <td>{r.dst}</td>
                      <td>{r.mtu}</td>
                      <td className="dim">{formatDuration(r.expiresIn)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {st.sessions.length > 0 && (
            <>
              <h4>Terminal</h4>
              <div className="term" ref={(el) => {
                  if (el) el.scrollTop = el.scrollHeight;
                }}>
                {st.sessions.map((s) => (
                  <div key={s.id}>
                    {s.lines.map((l, i) => (
                      <div key={i} className={/Unreachable|timeout|exceeded|!H|!N|Frag needed|too long|too big/.test(l) ? 'err' : /bytes from|complete|path MTU .* = /.test(l) ? 'ok' : ''}>
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
          <h4>
            MAC address table <Q id="mac-table" />
          </h4>
          <MacTable nodeId={nodeId} rows={st.mac} />
          <div className="hint">Entries age out after {formatDuration(st.agingNs)} without traffic from that address.</div>
        </>
      )}
      {st.kind === 'router' && (
        <>
          <h4>
            Routing table <Q id="routing-table" />
          </h4>
          <RouteTable rows={st.routes} />
          <div className="hint">Rows are in lookup order: the most specific prefix that matches wins <Q id="lpm" /></div>
          <h4>
            ARP cache <Q id="arp-cache" />
          </h4>
          <ArpTable nodeId={nodeId} rows={st.arp} showIface />
        </>
      )}
    </div>
  );
}
