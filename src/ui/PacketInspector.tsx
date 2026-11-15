/** Layer-by-layer header inspector + hex dump with field <-> byte highlighting. */
import { useMemo, useState } from 'react';
import { encodeFrame, formatDuration, summarizeFrame, type EncodedFrame, type FieldSpan, type LayerName, type TxEvent } from '../engine';
import { PACKET_COLORS, PACKET_LABELS } from '../render/colors';
import { FIELD_CONCEPT, FIELD_NOTES, LAYER_BLURB, LAYER_CONCEPT } from '../learn/fieldNotes';
import { explainPacket } from '../learn/explain';
import { sim, useSim } from '../state/sim';
import { ConceptCard, Q } from './learn/ConceptCard';

const LAYER_CLASS: Record<LayerName, string> = { 'Ethernet II': 'L-eth', ARP: 'L-arp', IPv4: 'L-ipv4', ICMP: 'L-icmp', UDP: 'L-udp', TCP: 'L-tcp', Data: 'L-data' };
const LAYER_COLOR: Record<LayerName, string> = { 'Ethernet II': '#9fb7cf', ARP: 'var(--arp)', IPv4: '#b9a3ff', ICMP: '#7cc4ff', UDP: '#fde047', TCP: '#fb923c', Data: '#9aa4b2' };

function nodeName(id: string): string {
  return useSim.getState().topology.nodes.find((n) => n.id === id)?.name ?? id;
}

function HexView({ bytes, fields, hot, onHover }: { bytes: Uint8Array; fields: FieldSpan[]; hot: Set<number>; onHover: (byte: number | null) => void }) {
  const layerOf = useMemo(() => {
    const arr: string[] = new Array(bytes.length).fill('');
    for (const f of fields) for (let i = f.start; i < f.end; i++) arr[i] = f.key === 'eth.padding' ? 'pad' : LAYER_CLASS[f.layer];
    return arr;
  }, [bytes, fields]);
  const lines = [];
  for (let off = 0; off < bytes.length; off += 16) {
    const row = Array.from(bytes.subarray(off, off + 16));
    lines.push(
      <div className="line" key={off}>
        <span className="off">{off.toString(16).padStart(4, '0')}</span>
        <span className="bytes">
          {row.map((b, i) => {
            const idx = off + i;
            return (
              <span key={idx} className={`b ${layerOf[idx]} ${hot.has(idx) ? 'hot' : ''}`} onMouseEnter={() => onHover(idx)} onMouseLeave={() => onHover(null)}>
                {b.toString(16).padStart(2, '0')}
              </span>
            );
          })}
        </span>
      </div>,
    );
  }
  return <div className="hex">{lines}</div>;
}

interface Seg {
  label: string;
  bytes: number;
  cls: string;
  title: string;
}

/** Header-by-header size breakdown, with the IP packet measured against the egress MTU. */
function Anatomy({ tx, enc }: { tx: TxEvent; enc: EncodedFrame }) {
  const fieldLen = (keys: string[]) => enc.fields.filter((f) => keys.includes(f.key)).reduce((n, f) => n + (f.end - f.start), 0);
  const pad = fieldLen(['eth.padding']);
  const segs: Seg[] = [];
  for (const l of enc.layers) {
    const len = l.end - l.start;
    if (l.layer === 'Ethernet II') segs.push({ label: 'Eth', bytes: len, cls: 'eth', title: `Ethernet header: ${len} bytes (not counted in the MTU)` });
    else if (l.layer === 'IPv4') segs.push({ label: 'IP', bytes: len, cls: 'ipv4', title: `IPv4 header: ${len} bytes` });
    else if (l.layer === 'ARP') segs.push({ label: 'ARP', bytes: len, cls: 'arp', title: `ARP message: ${len} bytes` });
    else {
      const name = l.layer === 'Data' ? 'data' : l.layer;
      const data = l.layer === 'Data' ? 0 : fieldLen([`${l.layer.toLowerCase()}.data`, 'icmp.original']);
      if (len - data > 0) segs.push({ label: name, bytes: len - data, cls: l.layer.toLowerCase(), title: `${name} ${l.layer === 'Data' ? '' : 'header'}: ${len - data} bytes` });
      if (data) segs.push({ label: 'data', bytes: data, cls: 'data', title: `Payload: ${data} bytes` });
    }
  }
  const frag = fieldLen(['data.fragment']);
  if (frag) segs.push({ label: 'fragment', bytes: frag, cls: 'data', title: `Fragment data: ${frag} bytes` });
  if (pad) segs.push({ label: 'pad', bytes: pad, cls: 'pad', title: `Padding to the 60-byte minimum: ${pad} bytes` });
  segs.push({ label: 'FCS', bytes: 4, cls: 'fcs', title: 'Frame check sequence: 4 bytes (added by the NIC; not in the hex view)' });
  const total = enc.bytes.length + 4;
  const p = tx.frame.eth.payload;
  const mtu = sim.state(tx.node)?.ports.find((x) => x.id === tx.iface)?.mtu ?? 1500;
  const ipLen = p.kind === 'ipv4' ? p.totalLength : 0;
  return (
    <div className="anatomy">
      <div className="anat-bar">
        {segs.map((sg, i) => (
          <div key={i} className={`seg-${sg.cls}`} style={{ flexGrow: Math.max(sg.bytes, total * 0.04) }} title={sg.title}>
            <span>
              {sg.label} {sg.bytes}
            </span>
          </div>
        ))}
      </div>
      <div className="hint">
        Frame {total} bytes (+8 preamble, +12 gap on the wire).
        {ipLen > 0 && (
          <>
            {' '}
            IP packet: <b>{ipLen}</b> of {mtu} MTU ({Math.round((ipLen / mtu) * 100)}%). <Q id="packet-anatomy" />
          </>
        )}
      </div>
    </div>
  );
}

function FlowHops({ tx }: { tx: TxEvent }) {
  useSim((s) => s.version);
  const setSelection = useSim((s) => s.setSelection);
  const hops = [...sim.packets.values()].filter((p) => p.flowId === tx.flowId);
  if (hops.length <= 1) return null;
  return (
    <>
      <h4>This flow, hop by hop</h4>
      <table className="tbl">
        <tbody>
          {hops.slice(0, 40).map((h) => (
            <tr key={h.packetId} className={h.packetId === tx.packetId ? 'hl-hit' : ''} style={{ cursor: 'pointer', background: h.packetId === tx.packetId ? 'rgba(94,234,212,0.12)' : undefined }} onClick={() => setSelection({ kind: 'packet', id: h.packetId! })}>
              <td className="dim">{(h.txStart / 1e6).toFixed(3)} ms</td>
              <td>
                {nodeName(h.node)} → {nodeName(h.toNode)}
              </td>
              <td className="dim">{h.frame.eth.payload.kind === 'ipv4' ? `ttl ${h.frame.eth.payload.ttl}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

export function PacketInspector({ packetId }: { packetId: string }) {
  const setSelection = useSim((s) => s.setSelection);
  const tx = sim.packets.get(packetId);
  const [hotField, setHotField] = useState<string | null>(null);
  const [hotByte, setHotByte] = useState<number | null>(null);
  const enc = useMemo(() => (tx ? encodeFrame(tx.frame.eth) : null), [tx]);

  if (!tx || !enc) return <div className="empty">Packet {packetId} is no longer in the capture buffer.</div>;

  // Fields under the hovered byte (bit fields can share a byte), or the hovered field itself.
  const activeFields = new Set<string>();
  if (hotField) activeFields.add(hotField);
  if (hotByte !== null) for (const f of enc.fields) if (hotByte >= f.start && hotByte < f.end) activeFields.add(f.key);
  const hotBytes = new Set<number>();
  for (const f of enc.fields) if (activeFields.has(f.key)) for (let i = f.start; i < f.end; i++) hotBytes.add(i);

  const layers = enc.layers.map((l) => ({ ...l, fields: enc.fields.filter((f) => f.layer === l.layer && !(f.key === 'eth.padding')) }));
  const padding = enc.fields.find((f) => f.key === 'eth.padding');
  const inFlight = sim.inFlight.has(packetId);

  return (
    <div className="panel">
      <div className="panel-title">
        <h3 style={{ color: PACKET_COLORS[tx.cls] }}>{PACKET_LABELS[tx.cls]}</h3>
        <span className="kind">{tx.packetId}</span>
        <span style={{ flex: 1 }} />
        <button className="btn icon" onClick={() => setSelection(null)} aria-label="Close inspector">
          ✕
        </button>
      </div>
      <div className="hint" style={{ fontFamily: 'var(--mono)', color: 'var(--text)' }}>
        {summarizeFrame(tx.frame.eth)}
      </div>
      <div className="story">{explainPacket(tx, sim.explainCtx).say}</div>
      <h4>
        Packet anatomy <Q id="mtu" />
      </h4>
      <Anatomy tx={tx} enc={enc} />
      <ConceptCard id="encapsulation" title="Why does a packet have layers?" />
      <table className="tbl wrap">
        <tbody>
          <tr>
            <td className="dim">Link</td>
            <td>
              {nodeName(tx.node)} {tx.iface} → {nodeName(tx.toNode)} {tx.toIface} {inFlight ? <span className="pill">on the wire</span> : <span className="pill">delivered</span>}
            </td>
          </tr>
          <tr>
            <td className="dim">Size</td>
            <td>
              {tx.size} B captured, {tx.wireSize} B on the wire
            </td>
          </tr>
          <tr>
            <td className="dim">Timing</td>
            <td>
              sent {(tx.txStart / 1e6).toFixed(3)} ms · {formatDuration(tx.txEnd - tx.txStart)} serialization · arrives {(tx.arrive / 1e6).toFixed(3)} ms
            </td>
          </tr>
          {tx.frame.parentId && (
            <tr>
              <td className="dim">From</td>
              <td>
                {sim.packets.has(tx.frame.parentId) ? (
                  <button className="btn" onClick={() => setSelection({ kind: 'packet', id: tx.frame.parentId! })}>
                    previous hop {tx.frame.parentId}
                  </button>
                ) : (
                  tx.frame.parentId
                )}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {layers.map((l) => (
        <details className="layer" open key={l.layer}>
          <summary style={{ color: LAYER_COLOR[l.layer] }}>
            {l.layer}
            <span className="sub">
              bytes {l.start}–{l.end - 1} ({l.end - l.start} B)
            </span>
          </summary>
          <div className="layer-blurb">
            {LAYER_BLURB[l.layer]} {LAYER_CONCEPT[l.layer] && <Q id={LAYER_CONCEPT[l.layer]!} />}
          </div>
          <div className="fields">
            {l.fields.map((f) => (
              <div key={f.key} className={`field ${activeFields.has(f.key) ? 'hot' : ''}`} onMouseEnter={() => setHotField(f.key)} onMouseLeave={() => setHotField(null)}>
                <span className="k">{f.label}</span>
                <span className="v">
                  {f.bits && <span className="bits">{f.bits}</span>}
                  {f.display}
                  {FIELD_CONCEPT[f.key] && <Q id={FIELD_CONCEPT[f.key]!} />}
                </span>
                {activeFields.has(f.key) && FIELD_NOTES[f.key] && <span className="note">{FIELD_NOTES[f.key]}</span>}
              </div>
            ))}
          </div>
        </details>
      ))}
      {padding && (
        <div className={`field ${activeFields.has('eth.padding') ? 'hot' : ''}`} onMouseEnter={() => setHotField('eth.padding')} onMouseLeave={() => setHotField(null)}>
          <span className="k">Ethernet padding</span>
          <span className="v">{padding.display} (frame padded to the 60-byte minimum)</span>
        </div>
      )}

      <h4>Bytes ({enc.bytes.length})</h4>
      <div className="layer-legend">
        {enc.layers.map((l) => (
          <span key={l.layer} style={{ color: LAYER_COLOR[l.layer] }}>
            {l.layer}
          </span>
        ))}
      </div>
      <HexView bytes={enc.bytes} fields={enc.fields} hot={hotBytes} onHover={setHotByte} />
      <div className="hint">Hover a field to see its bytes and what it's for, or hover a byte to find its field. Shown as captured: no preamble or FCS.</div>
      <FlowHops tx={tx} />
    </div>
  );
}
