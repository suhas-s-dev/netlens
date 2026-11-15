import { useRef, useState } from 'react';
import { LESSONS } from '../learn/lessons';
import { PRESETS } from '../presets';
import { startLesson, useLesson } from '../state/lesson';
import { sim, useSim } from '../state/sim';
import { deleteSaved, downloadJson, listSaved, parseTopology, saveTopology } from '../state/storage';

function FileDialog({ onClose }: { onClose: () => void }) {
  const topology = useSim((s) => s.topology);
  const [name, setName] = useState(topology.name);
  const [saved, setSaved] = useState(listSaved());
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const importText = (t: string) => {
    try {
      const topo = parseTopology(t);
      sim.load(topo, null);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Save and load topologies">
        <div className="panel-title">
          <h3>Topologies</h3>
          <span className="spacer" style={{ flex: 1 }} />
          <button className="btn icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <h4>Save to this browser</h4>
        <div className="row">
          <input className="grow" type="text" value={name} onChange={(e) => setName(e.target.value)} aria-label="Topology name" />
          <button
            className="btn primary"
            disabled={!name.trim()}
            onClick={() => {
              const ok = saveTopology(name.trim(), topology);
              setNote(ok ? `Saved "${name.trim()}"` : 'Could not save: browser storage is unavailable');
              setSaved(listSaved());
            }}
          >
            Save
          </button>
          <button className="btn" onClick={() => downloadJson({ ...topology, name: name.trim() || topology.name })}>
            Export JSON
          </button>
        </div>
        {note && <div className="hint">{note}</div>}
        <h4>Saved</h4>
        <div className="saved-list">
          {saved.length === 0 && <div className="hint">Nothing saved yet.</div>}
          {saved.map((s) => (
            <div className="item" key={s.name}>
              <span className="grow">{s.name}</span>
              <span className="hint">{new Date(s.savedAt).toLocaleString()}</span>
              <button
                className="btn"
                onClick={() => {
                  sim.load(s.topology, null);
                  onClose();
                }}
              >
                Load
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  deleteSaved(s.name);
                  setSaved(listSaved());
                }}
                aria-label={`Delete ${s.name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <h4>Import JSON</h4>
        <textarea placeholder='Paste a topology ({"version": 1, "nodes": [...], "links": [...]})' value={text} onChange={(e) => setText(e.target.value)} />
        {error && <div className="err-text" style={{ gridColumn: 'auto' }}>{error}</div>}
        <div className="row">
          <button className="btn primary" disabled={!text.trim()} onClick={() => importText(text)}>
            Import pasted JSON
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            Import file…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) importText(await f.text());
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function TopBar() {
  const presetId = useSim((s) => s.presetId);
  const topology = useSim((s) => s.topology);
  const viewMode = useSim((s) => s.viewMode);
  const mode = useSim((s) => s.mode);
  const setViewMode = useSim((s) => s.setViewMode);
  const setMode = useSim((s) => s.setMode);
  const [files, setFiles] = useState(false);
  const set = useSim((s) => s.set);
  const narration = useSim((s) => s.narration);
  const pixel = useSim((s) => s.pixel);
  const inLesson = useLesson((s) => !!s.lesson);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo" aria-hidden />
        NetLens
      </div>
      <select
        value={presetId ?? ''}
        onChange={(e) => {
          const p = PRESETS.find((x) => x.id === e.target.value);
          if (p) {
            sim.load(structuredClone(p.topology), p.id);
            useSim.getState().setMode('sim');
          }
        }}
        aria-label="Preset"
      >
        {presetId === null && <option value="">{topology.name}</option>}
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.topology.name}
          </option>
        ))}
      </select>
      <div className="seg" role="group" aria-label="Mode">
        <button className={mode === 'sim' ? 'on' : ''} onClick={() => setMode('sim')}>
          Simulate
        </button>
        <button className={mode === 'edit' ? 'on' : ''} onClick={() => setMode('edit')}>
          Edit
        </button>
      </div>
      <div className="seg" role="group" aria-label="View">
        <button className={viewMode === 'perspective' ? 'on' : ''} onClick={() => setViewMode('perspective')} title="Free 3D perspective">
          3D
        </button>
        <button className={viewMode === 'iso' ? 'on' : ''} onClick={() => setViewMode('iso')} title="2.5D isometric (orthographic)">
          Iso
        </button>
      </div>
      <span className="spacer" />
      {presetId && LESSONS[presetId] && !inLesson && (
        <button className="btn primary" onClick={() => startLesson(presetId)} title={LESSONS[presetId]!.summary}>
          ▶ Lesson
        </button>
      )}
      <button className="btn" onClick={() => set('glossary', 'index')} title="Every networking term used here, explained">
        Glossary
      </button>
      <label className="chk" title="Devices explain what they are doing in speech bubbles">
        <input type="checkbox" checked={narration} onChange={(e) => set('narration', e.target.checked)} />
        Narration
      </label>
      <label className="chk" title="Pixel-art rendering">
        <input type="checkbox" checked={pixel} onChange={(e) => set('pixel', e.target.checked)} />
        Pixel
      </label>
      <button className="btn" onClick={() => setFiles(true)}>
        Save / Load
      </button>
      {files && <FileDialog onClose={() => setFiles(false)} />}
    </header>
  );
}
