import { useState } from 'react';
import { CONCEPTS, type ConceptId } from '../../learn/concepts';
import { useSim } from '../../state/sim';

/** Compact "what is this?" card. Expands for the full explanation. */
export function ConceptCard({ id, title }: { id: ConceptId; title?: string }) {
  const [open, setOpen] = useState(false);
  const set = useSim((s) => s.set);
  const c = CONCEPTS[id];
  return (
    <div className="concept-card">
      <button className="cc-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="cc-badge">?</span>
        <span className="cc-title">
          {title ?? `What is a ${c.title.replace(/ \(.*\)$/, '').toLowerCase()}?`}
        </span>
        <span className="cc-toggle">{open ? '–' : '+'}</span>
      </button>
      <div className="cc-short">{c.short}</div>
      {open && (
        <div className="cc-body">
          <p>{c.body}</p>
          {c.analogy && (
            <p className="cc-analogy">
              <b>Think of it as:</b> {c.analogy}
            </p>
          )}
          <div className="chips">
            {c.related.map((r) => (
              <button key={r} className="chip" onClick={() => set('glossary', r)}>
                {CONCEPTS[r].title}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Small inline "?" that opens a concept in the glossary. */
export function Q({ id, title }: { id: ConceptId; title?: string }) {
  const set = useSim((s) => s.set);
  return (
    <button className="concept-chip" onClick={() => set('glossary', id)} title={title ?? CONCEPTS[id].short} aria-label={`Explain ${CONCEPTS[id].title}`}>
      ?
    </button>
  );
}
