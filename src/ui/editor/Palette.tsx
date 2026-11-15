import { useMemo } from 'react';
import { validateTopology, type NodeType } from '../../engine';
import { viewCenter } from '../../render/layout';
import { addNode, freeSpot } from '../../state/editOps';
import { useSim } from '../../state/sim';

const ITEMS: { type: NodeType; label: string; hint: string }[] = [
  { type: 'host', label: '+ Host', hint: 'End host: one interface, IP, gateway' },
  { type: 'switch', label: '+ Switch', hint: 'L2 learning switch (4 ports, add more in the panel)' },
  { type: 'router', label: '+ Router', hint: 'IPv4 router (2 interfaces, add more in the panel)' },
];

export function Palette() {
  const topology = useSim((s) => s.topology);
  const linkStart = useSim((s) => s.linkStart);
  const edit = useSim((s) => s.editTopology);
  const setSelection = useSim((s) => s.setSelection);
  const setMode = useSim((s) => s.setMode);
  const issues = useMemo(() => validateTopology(topology), [topology]);
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;

  return (
    <div className="overlay card palette">
      <h4>Add device</h4>
      {ITEMS.map((it) => (
        <button
          key={it.type}
          className="btn"
          title={it.hint}
          onClick={() => {
            let id = '';
            edit((t) => {
              const r = addNode(t, it.type, freeSpot(t, viewCenter));
              id = r.id;
              return r.topology;
            });
            setSelection({ kind: 'node', id });
          }}
        >
          {it.label}
        </button>
      ))}
      {linkStart && (
        <div className="hint" style={{ color: 'var(--warn)' }}>
          Linking from {topology.nodes.find((n) => n.id === linkStart.node)?.name} {linkStart.iface}: click a port on another device (Esc to cancel).
        </div>
      )}
      <div className="hint">
        {errors ? <span style={{ color: 'var(--error)' }}>{errors} error{errors > 1 ? 's' : ''}</span> : <span style={{ color: 'var(--ok)' }}>valid</span>}
        {warnings > 0 && <span style={{ color: 'var(--warn)' }}> · {warnings} warning{warnings > 1 ? 's' : ''}</span>}
      </div>
      <button className="btn primary" onClick={() => setMode('sim')}>
        ▶ Simulate this network
      </button>
    </div>
  );
}
