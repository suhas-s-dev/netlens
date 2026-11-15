import { useMemo } from 'react';
import { DEFAULT_LINK_BANDWIDTH_MBPS, DEFAULT_LINK_LATENCY_MS, validateTopology, type HostJson, type NodeJson, type RouterJson, type TopologyJson, type ValidationIssue } from '../../engine';

import { addInterface, emptyTopology, isLinked, removeInterface, removeLink, removeNode, setInterfaceIp, setInterfaceMtu, updateLink, updateNode } from '../../state/editOps';
import { sim, useSim } from '../../state/sim';

function useIssues(): ValidationIssue[] {
  const topology = useSim((s) => s.topology);
  return useMemo(() => validateTopology(topology), [topology]);
}

function Issues({ issues, onPick }: { issues: ValidationIssue[]; onPick?: (i: ValidationIssue) => void }) {
  if (!issues.length) return null;
  return (
    <div className="issues">
      {issues.map((i, k) => (
        <div key={k} className={`issue ${i.level}`} onClick={() => onPick?.(i)} role={onPick ? 'button' : undefined}>
          {i.message}
        </div>
      ))}
    </div>
  );
}

function FieldIssues({ issues }: { issues: ValidationIssue[] }) {
  return (
    <>
      {issues.map((i, k) => (
        <div key={k} className="err-text" style={i.level === 'warning' ? { color: 'var(--warn)' } : undefined}>
          {i.message}
        </div>
      ))}
    </>
  );
}

function NodeEditor({ node, issues }: { node: NodeJson; issues: ValidationIssue[] }) {
  const edit = useSim((s) => s.editTopology);
  const topology = useSim((s) => s.topology);
  const setSelection = useSim((s) => s.setSelection);
  const setLinkStart = useSim((s) => s.setLinkStart);
  const mine = issues.filter((i) => i.node === node.id);
  const upd = (fn: (n: NodeJson) => NodeJson) => edit((t) => updateNode(t, node.id, fn));
  const links = topology.links.filter((l) => l.a.node === node.id || l.b.node === node.id);
  const name = (id: string) => topology.nodes.find((n) => n.id === id)?.name ?? id;

  return (
    <div className="panel">
      <div className="panel-title">
        <h3>{node.name}</h3>
        <span className="kind">{node.type}</span>
        <span style={{ flex: 1 }} />
        <button
          className="btn danger"
          onClick={() => {
            edit((t) => removeNode(t, node.id));
            setSelection(null);
          }}
        >
          Delete
        </button>
      </div>
      <div className="form">
        <label htmlFor="ed-name">Name</label>
        <input id="ed-name" type="text" value={node.name} onChange={(e) => upd((n) => ({ ...n, name: e.target.value }))} />
        {node.type === 'host' && (
          <>
            <label htmlFor="ed-ip">IP / prefix</label>
            <input
              id="ed-ip"
              type="text"
              placeholder="10.0.0.10/24"
              value={node.interfaces[0]?.ip ?? ''}
              className={mine.some((i) => i.iface && i.level === 'error') ? 'invalid' : ''}
              onChange={(e) => edit((t) => setInterfaceIp(t, node.id, node.interfaces[0]!.id, e.target.value.trim()))}
            />
            <FieldIssues issues={mine.filter((i) => i.iface)} />
            <label htmlFor="ed-gw">Gateway</label>
            <input
              id="ed-gw"
              type="text"
              placeholder="10.0.0.1 (optional)"
              value={(node as HostJson).gateway ?? ''}
              onChange={(e) =>
                upd((n) => {
                  const h = { ...(n as HostJson) };
                  const v = e.target.value.trim();
                  if (v) h.gateway = v;
                  else delete h.gateway;
                  return h;
                })
              }
            />
            <FieldIssues issues={mine.filter((i) => !i.iface && /gateway/i.test(i.message))} />
            <label htmlFor="ed-mtu">MTU</label>
            <input
              id="ed-mtu"
              type="number"
              min={68}
              max={9216}
              placeholder="1500"
              value={node.interfaces[0]?.mtu ?? ''}
              onChange={(e) => edit((t) => setInterfaceMtu(t, node.id, node.interfaces[0]!.id, e.target.value))}
            />
            <label>MAC</label>
            <span className="hint" style={{ fontFamily: 'var(--mono)' }}>
              {node.interfaces[0]?.mac}
            </span>
          </>
        )}
      </div>

      {node.type !== 'host' && (
        <>
          <h4>{node.type === 'switch' ? 'Ports' : 'Interfaces'}</h4>
          <table className="tbl">
            <tbody>
              {node.interfaces.map((i) => {
                const linked = isLinked(topology, { node: node.id, iface: i.id });
                const ifIssues = mine.filter((x) => x.iface === i.id);
                return (
                  <tr key={i.id}>
                    <td style={{ width: 44 }}>{node.type === 'switch' ? `p${i.id}` : i.id}</td>
                    <td>
                      {node.type === 'router' ? (
                        <>
                          <input
                            type="text"
                            placeholder="10.0.1.1/24"
                            value={i.ip ?? ''}
                            className={ifIssues.some((x) => x.level === 'error') ? 'invalid' : ''}
                            onChange={(e) => edit((t) => setInterfaceIp(t, node.id, i.id, e.target.value.trim()))}
                            style={{ width: '100%' }}
                            aria-label={`${i.id} address`}
                          />
                          {ifIssues.map((x, k) => (
                            <div key={k} className="err-text" style={{ whiteSpace: 'normal' }}>
                              {x.message}
                            </div>
                          ))}
                        </>
                      ) : (
                        <span className="dim">{i.mac}</span>
                      )}
                    </td>
                    {node.type === 'router' && (
                      <td style={{ width: 64 }}>
                        <input type="number" min={68} max={9216} placeholder="1500" title="MTU" aria-label={`${i.id} MTU`} value={i.mtu ?? ''} onChange={(e) => edit((t) => setInterfaceMtu(t, node.id, i.id, e.target.value))} style={{ width: '100%' }} />
                      </td>
                    )}
                    <td style={{ width: 70 }}>{linked ? <span className="pill">linked</span> : <button className="btn" onClick={() => setLinkStart({ node: node.id, iface: i.id })} title="Pick this port, then click another device's port">Link…</button>}</td>
                    <td style={{ width: 30 }}>
                      <button className="btn icon danger" disabled={node.interfaces.length <= 1} onClick={() => edit((t) => removeInterface(t, node.id, i.id))} aria-label={`Remove ${i.id}`}>
                        ✕
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button className="btn" onClick={() => edit((t) => addInterface(t, node.id))}>
            + Add {node.type === 'switch' ? 'port' : 'interface'}
          </button>
        </>
      )}

      {node.type === 'router' && (
        <>
          <h4>Static routes</h4>
          <table className="tbl">
            <thead>
              <tr>
                <th>Prefix</th>
                <th>Next hop</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(node as RouterJson).staticRoutes.map((r, k) => (
                <tr key={k}>
                  <td>
                    <input type="text" value={r.prefix} placeholder="10.0.3.0/24" style={{ width: '100%' }} aria-label="Route prefix" onChange={(e) => upd((n) => ({ ...(n as RouterJson), staticRoutes: (n as RouterJson).staticRoutes.map((x, j) => (j === k ? { ...x, prefix: e.target.value.trim() } : x)) }))} />
                  </td>
                  <td>
                    <input type="text" value={r.nextHop} placeholder="10.0.12.2" style={{ width: '100%' }} aria-label="Next hop" onChange={(e) => upd((n) => ({ ...(n as RouterJson), staticRoutes: (n as RouterJson).staticRoutes.map((x, j) => (j === k ? { ...x, nextHop: e.target.value.trim() } : x)) }))} />
                  </td>
                  <td style={{ width: 30 }}>
                    <button className="btn icon danger" onClick={() => upd((n) => ({ ...(n as RouterJson), staticRoutes: (n as RouterJson).staticRoutes.filter((_, j) => j !== k) }))} aria-label="Remove route">
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <FieldIssues issues={mine.filter((i) => !i.iface && /route|next hop/i.test(i.message))} />
          <button className="btn" onClick={() => upd((n) => ({ ...(n as RouterJson), staticRoutes: [...(n as RouterJson).staticRoutes, { prefix: '0.0.0.0/0', nextHop: '' }] }))}>
            + Add static route
          </button>
          <div className="hint">Connected routes are added automatically for each interface address.</div>
        </>
      )}

      {links.length > 0 && (
        <>
          <h4>Links</h4>
          {links.map((l) => {
            const [me, other] = l.a.node === node.id ? [l.a, l.b] : [l.b, l.a];
            return (
              <div className="row" key={l.id}>
                <button className="btn grow" style={{ textAlign: 'left' }} onClick={() => setSelection({ kind: 'link', id: l.id })}>
                  {me.iface} ↔ {name(other.node)} {other.iface}
                </button>
                <button className="btn icon danger" onClick={() => edit((t) => removeLink(t, l.id))} aria-label="Remove link">
                  ✕
                </button>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function LinkEditor({ linkId }: { linkId: string }) {
  const topology = useSim((s) => s.topology);
  const edit = useSim((s) => s.editTopology);
  const setSelection = useSim((s) => s.setSelection);
  const l = topology.links.find((x) => x.id === linkId);
  if (!l) return null;
  const name = (id: string) => topology.nodes.find((n) => n.id === id)?.name ?? id;
  const num = (v: string) => (v === '' ? undefined : Math.max(0, Number(v)));
  return (
    <div className="panel">
      <div className="panel-title">
        <h3>
          {name(l.a.node)} {l.a.iface} ↔ {name(l.b.node)} {l.b.iface}
        </h3>
        <span style={{ flex: 1 }} />
        <button
          className="btn danger"
          onClick={() => {
            edit((t) => removeLink(t, l.id));
            setSelection(null);
          }}
        >
          Delete link
        </button>
      </div>
      <div className="form">
        <label htmlFor="ed-lat">Latency (ms)</label>
        <input id="ed-lat" type="number" min={0} step={0.5} placeholder={String(DEFAULT_LINK_LATENCY_MS)} value={l.latencyMs ?? ''} onChange={(e) => edit((t) => updateLink(t, l.id, { latencyMs: num(e.target.value) }))} />
        <label htmlFor="ed-bw">Bandwidth (Mb/s)</label>
        <input id="ed-bw" type="number" min={0.01} step={1} placeholder={String(DEFAULT_LINK_BANDWIDTH_MBPS)} value={l.bandwidthMbps ?? ''} onChange={(e) => edit((t) => updateLink(t, l.id, { bandwidthMbps: num(e.target.value) || undefined }))} />
        <label htmlFor="ed-loss">Loss (%)</label>
        <input id="ed-loss" type="number" min={0} max={100} step={1} placeholder="0" value={l.lossPercent ?? ''} onChange={(e) => edit((t) => updateLink(t, l.id, { lossPercent: num(e.target.value) || undefined }))} />
      </div>
      <div className="hint">Lower bandwidth makes serialization visible: big frames become long streaks and queue behind each other.</div>
    </div>
  );
}

function TopologyEditor({ issues }: { issues: ValidationIssue[] }) {
  const topology = useSim((s) => s.topology);
  const edit = useSim((s) => s.editTopology);
  const focusNode = useSim((s) => s.focusNode);
  return (
    <div className="panel">
      <div className="form">
        <label htmlFor="ed-tname">Network name</label>
        <input id="ed-tname" type="text" value={topology.name} onChange={(e) => edit((t) => ({ ...t, name: e.target.value }))} />
      </div>
      <div className="hint">
        Add devices with the palette, drag them to arrange. To connect, click a grey port in front of one device, then a port on another. <kbd>Esc</kbd> cancels. Select a device or link to edit it;{' '}
        <kbd>Delete</kbd> removes it.
      </div>
      <div className="row">
        <button
          className="btn danger"
          onClick={() => {
            if (topology.nodes.length === 0 || confirm('Start a new empty network? The current one is kept only if you saved it.')) {
              sim.load(emptyTopology(), null);
              useSim.getState().setMode('edit');
            }
          }}
        >
          New empty network
        </button>
      </div>
      <h4>Validation</h4>
      {issues.length === 0 ? <div className="hint" style={{ color: 'var(--ok)' }}>No problems found.</div> : <Issues issues={issues} onPick={(i) => i.node && focusNode(i.node)} />}
    </div>
  );
}

export function EditorPanel() {
  const selection = useSim((s) => s.selection);
  const topology = useSim((s) => s.topology);
  const issues = useIssues();
  const node = selection?.kind === 'node' ? topology.nodes.find((n) => n.id === selection.id) : undefined;
  if (node) return <NodeEditor node={node} issues={issues} />;
  if (selection?.kind === 'link') return <LinkEditor linkId={selection.id} />;
  return <TopologyEditor issues={issues} />;
}

export function validationSummary(t: TopologyJson): { errors: number; warnings: number } {
  const i = validateTopology(t);
  return { errors: i.filter((x) => x.level === 'error').length, warnings: i.filter((x) => x.level === 'warning').length };
}
