/**
 * Screen-space labels: one DOM layer over the canvas, positioned every frame by projecting
 * world anchors with the active camera. (Cheaper and more robust than a React root per label.)
 */
import { useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import type { NodeJson } from '../engine';
import { useSim } from '../state/sim';
import { freePortPositions, linkGeometry, nodePos, portAnchors } from './layout';

const els = new Map<string, HTMLElement>();
const anchors = new Map<string, THREE.Vector3>();

const v = new THREE.Vector3();

/** Lives inside the Canvas. */
export function LabelProjector() {
  const { camera, size } = useThree();
  useFrame(() => {
    for (const [key, el] of els) {
      const a = anchors.get(key);
      if (!a) continue;
      v.copy(a).project(camera);
      if (v.z > 1 || v.z < -1) {
        el.style.visibility = 'hidden';
        continue;
      }
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      el.style.visibility = '';
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
    }
  });
  return null;
}

function useLabel(key: string, pos: THREE.Vector3) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    anchors.set(key, pos);
    if (ref.current) els.set(key, ref.current);
    return () => {
      els.delete(key);
      anchors.delete(key);
    };
  }, [key, pos]);
  return ref;
}

function ipsOf(n: NodeJson): string[] {
  if (n.type === 'switch') return [];
  return n.interfaces.filter((i) => i.ip).map((i) => (n.type === 'router' ? `${i.id} ${i.ip}` : i.ip!));
}

function DeviceLabel({ node }: { node: NodeJson }) {
  const selected = useSim((s) => s.selection?.kind === 'node' && s.selection.id === node.id);
  const lod = useSim((s) => s.lod);
  const pos = useMemo(() => nodePos(node).setY(node.type === 'host' ? 1.6 : 1.0), [node]);
  const ref = useLabel(`node:${node.id}`, pos);
  return (
    <div ref={ref} className={`device-label ${node.type} ${selected ? 'selected' : ''}`} style={{ visibility: 'hidden' }}>
      <b>{node.name}</b>
      {/* Routers have one address per interface: list them once zoomed in, to keep the overview readable. */}
      {(node.type !== 'router' || lod !== 'far') &&
        ipsOf(node).map((ip) => (
          <span key={ip}>{ip}</span>
        ))}
      {lod === 'near' && node.type === 'host' && node.gateway && <span className="dim">gw {node.gateway}</span>}
    </div>
  );
}

const TONE_ICON: Record<string, string> = { info: '›', good: '✓', warn: '?', bad: '✕', muted: '·' };

/** The device "talking": what it just did and why, in its own voice. */
function DeviceBubble({ node }: { node: NodeJson }) {
  const bubble = useSim((s) => s.bubbles[node.id]);
  const playing = useSim((s) => s.playing);
  const narration = useSim((s) => s.narration);
  const set = useSim((s) => s.set);
  const pos = useMemo(() => nodePos(node).setY(node.type === 'host' ? 2.7 : 2.1), [node]);
  const ref = useLabel(`bubble:${node.id}`, pos);
  const show = narration && !!bubble;
  return (
    <div ref={ref} className="bubble-anchor" style={{ visibility: 'hidden' }}>
      {show && (
        <div key={bubble.n} className={`bubble ${playing ? '' : 'paused'} tone-${bubble.lines[bubble.lines.length - 1]!.tone}`}>
          <div className="bubble-who">{node.name}</div>
          {bubble.lines.map((l, i) => (
            <div key={i} className={`bubble-line tone-${l.tone}`}>
              <span className="ico">{TONE_ICON[l.tone]}</span>
              <span>
                {l.say}
                {l.concept && (
                  <button className="concept-chip" onClick={() => set('glossary', l.concept!)} title="What does this mean?">
                    ?
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PortLabel({ id, label, pos }: { id: string; label: string; pos: THREE.Vector3 }) {
  const ref = useLabel(`port:${id}`, pos);
  return (
    <div ref={ref} className="port-label" style={{ visibility: 'hidden' }}>
      {label}
    </div>
  );
}

/** Lives outside the Canvas, layered over it. */
export function LabelsLayer() {
  const topology = useSim((s) => s.topology);
  const lod = useSim((s) => s.lod);
  const mode = useSim((s) => s.mode);
  const ports = useMemo(() => {
    const nodes = new Map(topology.nodes.map((n) => [n.id, n]));
    const all = [...portAnchors(linkGeometry(topology)).entries()];
    if (mode === 'edit') all.push(...freePortPositions(topology).entries());
    return all.map(([key, p]) => {
      const [nodeId, iface] = key.split('.') as [string, string];
      const n = nodes.get(nodeId)!;
      return { id: key, label: n.type === 'switch' ? `p${iface}` : iface, pos: p.clone().setY(p.y + 0.45) };
    });
  }, [topology, mode]);
  return (
    <div className="labels" aria-hidden>
      {topology.nodes.map((n) => (
        <DeviceLabel key={n.id} node={n} />
      ))}
      {(lod === 'near' || mode === 'edit') && ports.map((p) => <PortLabel key={p.id} {...p} />)}
      {mode === 'sim' && topology.nodes.map((n) => <DeviceBubble key={`b-${n.id}`} node={n} />)}
    </div>
  );
}
