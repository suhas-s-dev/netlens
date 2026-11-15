import { useEffect, useMemo, useState } from 'react';
import { isValidIp } from '../engine';
import { sim, useSim } from '../state/sim';

/** Ping / traceroute launcher. Commands go through the controller → engine. */
export function CommandPanel() {
  const topology = useSim((s) => s.topology);
  const selection = useSim((s) => s.selection);
  const hosts = topology.nodes.filter((n) => n.type === 'host');
  const [src, setSrc] = useState(hosts[0]?.id ?? '');
  const [dst, setDst] = useState('');
  const [count, setCount] = useState(4);

  useEffect(() => {
    if (selection?.kind === 'node' && hosts.some((h) => h.id === selection.id)) setSrc(selection.id);
  }, [selection]);
  useEffect(() => {
    if (!hosts.some((h) => h.id === src)) setSrc(hosts[0]?.id ?? '');
  }, [topology]);

  const knownIps = useMemo(
    () => topology.nodes.flatMap((n) => (n.type === 'switch' ? [] : n.interfaces.filter((i) => i.ip).map((i) => ({ ip: i.ip!.split('/')[0]!, label: `${n.name} ${i.id}` })))),
    [topology],
  );
  const valid = isValidIp(dst);
  const canRun = !!src && valid;

  return (
    <div className="overlay card cmd">
      <h4>Send traffic</h4>
      <div className="row">
        <select className="grow" value={src} onChange={(e) => setSrc(e.target.value)} aria-label="Source host">
          {hosts.length === 0 && <option value="">No hosts</option>}
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <span className="hint">→</span>
        <input
          className={`grow ${dst && !valid ? 'invalid' : ''}`}
          type="text"
          list="known-ips"
          placeholder="destination IP"
          value={dst}
          onChange={(e) => setDst(e.target.value.trim())}
          onKeyDown={(e) => e.key === 'Enter' && canRun && sim.ping(src, dst, count)}
          aria-label="Destination IP"
        />
        <datalist id="known-ips">
          {knownIps.map((k) => (
            <option key={k.ip} value={k.ip}>
              {k.label}
            </option>
          ))}
        </datalist>
      </div>
      <div className="row">
        <button className="btn primary grow" disabled={!canRun} onClick={() => sim.ping(src, dst, count)}>
          Ping
        </button>
        <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} style={{ width: 56 }} aria-label="Ping count" title="Ping count" />
        <button className="btn grow" disabled={!canRun} onClick={() => sim.traceroute(src, dst)}>
          Traceroute
        </button>
      </div>
    </div>
  );
}
