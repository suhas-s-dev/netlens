import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { TraceEvent } from '../engine';
import { sim, useSim } from '../state/sim';

const TYPES: { key: TraceEvent['type']; label: string; title: string }[] = [
  { key: 'decision', label: 'decisions', title: 'Forwarding, flooding, routing and ARP decisions' },
  { key: 'table', label: 'tables', title: 'ARP / MAC table changes' },
  { key: 'drop', label: 'drops', title: 'Discarded frames and packets' },
  { key: 'app', label: 'ping/trace', title: 'Ping and traceroute output' },
  { key: 'tx', label: 'tx', title: 'Frames put on a link' },
  { key: 'rx', label: 'rx', title: 'Frames received' },
];
const MAX_ROWS = 600;

export function EventLog({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const log = useSim((s) => s.log);
  const filter = useSim((s) => s.logFilter);
  const setFilter = useSim((s) => s.setLogFilter);
  const nodes = useSim((s) => s.topology.nodes);
  const selection = useSim((s) => s.selection);
  const setSelection = useSim((s) => s.setSelection);
  const focusNode = useSim((s) => s.focusNode);
  const explainLog = useSim((s) => s.explainLog);
  const set = useSim((s) => s.set);
  const [follow, setFollow] = useState(true);
  const body = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const out: TraceEvent[] = [];
    for (let i = log.length - 1; i >= 0 && out.length < MAX_ROWS; i--) {
      const e = log[i]!;
      if (!filter.types[e.type]) continue;
      if (filter.node && e.node !== filter.node && !(e.type === 'tx' && e.toNode === filter.node)) continue;
      if (e.type === 'app' && e.status === 'sent') continue;
      out.push(e);
    }
    return out.reverse();
  }, [log, filter]);

  useLayoutEffect(() => {
    if (follow && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [rows, follow]);

  // Pause auto-follow when the user scrolls up; resume at the bottom.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const onScroll = () => setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, [open]);

  const onPick = (e: TraceEvent) => {
    if (e.packetId && (e.type === 'tx' || e.type === 'rx') && sim.packets.has(e.packetId)) {
      sim.pause();
      setSelection({ kind: 'packet', id: e.packetId });
    } else if (e.node) {
      focusNode(e.node);
    }
  };

  return (
    <section className="log" aria-label="Event log">
      <div className="log-head">
        <span className="title" onClick={onToggle} role="button" title={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'} Event log
        </span>
        {open && (
          <>
            <select value={filter.node ?? ''} onChange={(e) => setFilter({ node: e.target.value || null })} aria-label="Filter by device">
              <option value="">All devices</option>
              {nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
            {TYPES.map((t) => (
              <label key={t.key} className="chk" title={t.title}>
                <input type="checkbox" checked={!!filter.types[t.key]} onChange={(e) => setFilter({ types: { ...filter.types, [t.key]: e.target.checked } })} />
                {t.label}
              </label>
            ))}
            <span style={{ flex: 1 }} />
            <label className="chk" title="Show each event as a plain-English explanation instead of engine output">
              <input type="checkbox" checked={explainLog} onChange={(e) => set('explainLog', e.target.checked)} />
              plain English
            </label>
            <span className="hint">{follow ? 'following' : 'scroll to bottom to follow'}</span>
          </>
        )}
      </div>
      {open && (
        <div className="log-body" ref={body}>
          {rows.length === 0 && <div className="empty">No events yet. Press Play, or send a ping.</div>}
          {rows.map((e) => {
            const sel = selection?.kind === 'packet' && e.packetId === selection.id;
            const x = explainLog && e.type !== 'tx' && e.type !== 'rx' ? sim.explain(e) : null;
            const who = e.node ? (nodes.find((n) => n.id === e.node)?.name ?? e.node) : '';
            return (
              <div key={e.seq} className={`ev ${e.type} ${sel ? 'sel' : ''} ${x ? `tone-${x.tone}` : ''}`} onClick={() => onPick(e)} title={x ? `${e.text}${x.why ? `\nWhy: ${x.why}` : ''}` : e.text}>
                <span className="t">{(e.time / 1e6).toFixed(3)} ms</span>
                <span className="ty">{e.type === 'app' ? e.app : e.type}</span>
                <span className="tx">{x ? `${who}: ${x.say}` : e.text}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
