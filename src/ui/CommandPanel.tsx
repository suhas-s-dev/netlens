import { useEffect, useMemo, useState } from 'react';
import { isValidIp } from '../engine';
import { sim, useSim } from '../state/sim';
import { Q } from './learn/ConceptCard';

type Tool = 'ping' | 'traceroute' | 'mtr' | 'pmtud' | 'tcp' | 'udp';

const TOOLS: { id: Tool; label: string; hint: string }[] = [
  { id: 'ping', label: 'Ping', hint: 'ICMP echo: is it reachable, how fast?' },
  { id: 'traceroute', label: 'Trace', hint: 'Find every router on the path using TTL' },
  { id: 'mtr', label: 'MTR', hint: 'Traceroute in rounds, with loss and latency per hop' },
  { id: 'pmtud', label: 'PMTUD', hint: 'Find the smallest MTU on the path with DF probes' },
  { id: 'tcp', label: 'TCP', hint: 'Open a TCP connection (port 80 = web server on every host) and download bytes' },
  { id: 'udp', label: 'UDP', hint: 'Send UDP datagrams (port 7 = echo service on every host)' },
];

/** Network tools launcher. Commands go through the controller → engine. */
export function CommandPanel() {
  const topology = useSim((s) => s.topology);
  const selection = useSim((s) => s.selection);
  const hosts = topology.nodes.filter((n) => n.type === 'host');
  const [src, setSrc] = useState(hosts[0]?.id ?? '');
  const [dst, setDst] = useState('');
  const [tool, setTool] = useState<Tool>('ping');
  const [count, setCount] = useState(4);
  const [size, setSize] = useState(32);
  const [df, setDf] = useState(false);
  const [port, setPort] = useState(80);
  const [bytes, setBytes] = useState(4000);

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
  const run = () => {
    if (!canRun) return;
    if (tool === 'ping') sim.ping(src, dst, count, { size, df });
    else if (tool === 'traceroute') sim.traceroute(src, dst);
    else if (tool === 'mtr') sim.mtr(src, dst, Math.min(count, 20));
    else if (tool === 'tcp') sim.tcp(src, dst, port, bytes);
    else if (tool === 'udp') sim.udp(src, dst, port, Math.min(count, 20), size);
    else sim.pmtud(src, dst);
  };

  return (
    <div className="overlay card cmd">
      <h4>Send traffic</h4>
      <div className="seg tools" role="group" aria-label="Tool">
        {TOOLS.map((t) => (
          <button key={t.id} className={tool === t.id ? 'on' : ''} onClick={() => setTool(t.id)} title={t.hint}>
            {t.label}
          </button>
        ))}
      </div>
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
          onKeyDown={(e) => e.key === 'Enter' && run()}
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
      {tool === 'ping' && (
        <div className="row opts">
          <label title="How many echo requests">
            ×
            <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} aria-label="Ping count" />
          </label>
          <label title="ICMP data bytes (IP packet = data + 28)">
            data
            <input type="number" min={0} max={65000} value={size} onChange={(e) => setSize(Math.max(0, Math.min(65000, Number(e.target.value) || 0)))} aria-label="Ping data size" style={{ width: 66 }} />
          </label>
          <label className="chk" title="Don't Fragment: routers must drop it instead of fragmenting">
            <input type="checkbox" checked={df} onChange={(e) => setDf(e.target.checked)} />
            DF <Q id="df" />
          </label>
        </div>
      )}
      {tool === 'ping' && <div className="hint">IP packet = {size + 28} bytes{size + 28 > 1500 ? ' (bigger than 1500: it will be fragmented, or rejected with DF)' : ''}</div>}
      {tool === 'mtr' && (
        <div className="row opts">
          <label>
            rounds
            <input type="number" min={1} max={20} value={Math.min(count, 20)} onChange={(e) => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} aria-label="MTR rounds" />
          </label>
          <Q id="mtr" />
        </div>
      )}
      {(tool === 'tcp' || tool === 'udp') && (
        <div className="row opts">
          <label title={tool === 'tcp' ? 'Every host runs a web server on port 80; other ports are closed (RST)' : 'Every host runs an echo service on port 7; other ports get ICMP Port Unreachable'}>
            port
            <input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(Math.max(1, Math.min(65535, Number(e.target.value) || 1)))} aria-label="Destination port" style={{ width: 64 }} />
          </label>
          {tool === 'tcp' ? (
            <label title="How many bytes to ask the server for">
              bytes
              <input type="number" min={64} max={200000} value={bytes} onChange={(e) => setBytes(Math.max(64, Math.min(200000, Number(e.target.value) || 64)))} aria-label="Bytes to download" style={{ width: 72 }} />
            </label>
          ) : (
            <>
              <label>
                ×
                <input type="number" min={1} max={20} value={Math.min(count, 20)} onChange={(e) => setCount(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} aria-label="Datagram count" />
              </label>
              <label>
                size
                <input type="number" min={8} max={65000} value={size} onChange={(e) => setSize(Math.max(8, Math.min(65000, Number(e.target.value) || 8)))} aria-label="Datagram size" style={{ width: 64 }} />
              </label>
            </>
          )}
          <Q id={tool === 'tcp' ? 'tcp' : 'udp'} />
        </div>
      )}
      <button className="btn primary" disabled={!canRun} onClick={run}>
        ▶ Run {TOOLS.find((t) => t.id === tool)!.label}
      </button>
    </div>
  );
}
