import { DEFAULT_LINK_BANDWIDTH_MBPS, DEFAULT_LINK_LATENCY_MS } from '../engine';
import { sim, useSim } from '../state/sim';
import { LESSONS } from '../learn/lessons';
import { startLesson } from '../state/lesson';
import { DevicePanel } from './DevicePanel';
import { EditorPanel } from './editor/EditorPanel';
import { ConceptCard } from './learn/ConceptCard';
import { PacketInspector } from './PacketInspector';

function LinkPanel({ linkId }: { linkId: string }) {
  useSim((s) => s.version);
  const topology = useSim((s) => s.topology);
  const setSelection = useSim((s) => s.setSelection);
  const l = topology.links.find((x) => x.id === linkId);
  if (!l) return <div className="empty">Link not found.</div>;
  const name = (id: string) => topology.nodes.find((n) => n.id === id)?.name ?? id;
  const frames = [...sim.inFlight.values()].filter((t) => t.link === linkId);
  return (
    <div className="panel">
      <div className="panel-title">
        <h3>
          {name(l.a.node)} {l.a.iface} ↔ {name(l.b.node)} {l.b.iface}
        </h3>
        <span className="kind">link</span>
      </div>
      <table className="tbl">
        <tbody>
          <tr>
            <td className="dim">Propagation delay</td>
            <td>{l.latencyMs ?? DEFAULT_LINK_LATENCY_MS} ms</td>
          </tr>
          <tr>
            <td className="dim">Bandwidth</td>
            <td>{l.bandwidthMbps ?? DEFAULT_LINK_BANDWIDTH_MBPS} Mb/s (full duplex)</td>
          </tr>
        </tbody>
      </table>
      <ConceptCard id="link" title="What is a link?" />
      <ConceptCard id="serialization" title="Why do big frames take longer?" />
      <h4>On the wire now ({frames.length})</h4>
      {frames.map((f) => (
        <button key={f.packetId} className="btn" style={{ textAlign: 'left' }} onClick={() => setSelection({ kind: 'packet', id: f.packetId! })}>
          {f.text.split(': ').slice(1).join(': ')}
        </button>
      ))}
    </div>
  );
}

function LessonCallout() {
  const presetId = useSim((s) => s.presetId);
  const lesson = presetId ? LESSONS[presetId] : undefined;
  if (!lesson) return null;
  return (
    <div className="lesson-callout">
      <div className="pixel">Guided lesson</div>
      <b>{lesson.title}</b>
      <p>{lesson.summary}</p>
      <button className="btn primary" onClick={() => startLesson(lesson.presetId)}>
        ▶ Start the lesson
      </button>
    </div>
  );
}

function Welcome() {
  const topology = useSim((s) => s.topology);
  return (
    <div className="panel">
      <div className="panel-title">
        <h3>{topology.name}</h3>
      </div>
      {topology.description && <p style={{ margin: 0, color: 'var(--text-dim)' }}>{topology.description}</p>}
      <LessonCallout />
      <div className="empty" style={{ textAlign: 'left', padding: 0 }}>
        Press <kbd>Space</kbd> to play or pause, and <kbd>.</kbd> to step one event.
        <br />
        Click a device to see its live tables. Double-click to fly to it.
        <br />
        Click a moving packet to pause and inspect its headers and bytes.
        <br />
        Scroll to zoom: more detail appears as you get closer.
      </div>
    </div>
  );
}

export function SidePanel() {
  const selection = useSim((s) => s.selection);
  const mode = useSim((s) => s.mode);
  return (
    <aside className="side">
      {mode === 'edit' ? (
        <EditorPanel />
      ) : selection?.kind === 'node' ? (
        <DevicePanel nodeId={selection.id} />
      ) : selection?.kind === 'packet' ? (
        <PacketInspector packetId={selection.id} />
      ) : selection?.kind === 'link' ? (
        <LinkPanel linkId={selection.id} />
      ) : (
        <Welcome />
      )}
    </aside>
  );
}
