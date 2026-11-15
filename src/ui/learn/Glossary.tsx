import { useEffect, useMemo, useState } from 'react';
import { CONCEPT_LIST, CONCEPTS } from '../../learn/concepts';
import { useSim } from '../../state/sim';

/** Slide-over glossary of every concept, with cross-links. */
export function Glossary() {
  const glossary = useSim((s) => s.glossary);
  const set = useSim((s) => s.set);
  const [q, setQ] = useState('');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && set('glossary', null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [set]);
  const list = useMemo(() => CONCEPT_LIST.filter((c) => !q || `${c.title} ${c.short}`.toLowerCase().includes(q.toLowerCase())), [q]);
  if (!glossary) return null;
  const c = glossary === 'index' ? null : CONCEPTS[glossary];
  return (
    <div className="glossary card" role="dialog" aria-label="Glossary">
      <div className="panel-title">
        <h3 className="pixel">{c ? c.title : 'Glossary'}</h3>
        <span style={{ flex: 1 }} />
        {c && (
          <button className="btn" onClick={() => set('glossary', 'index')}>
            All terms
          </button>
        )}
        <button className="btn icon" onClick={() => set('glossary', null)} aria-label="Close glossary">
          ✕
        </button>
      </div>
      {c ? (
        <div className="gl-body">
          <p className="cc-short" style={{ fontSize: 14 }}>
            {c.short}
          </p>
          <p>{c.body}</p>
          {c.analogy && (
            <p className="cc-analogy">
              <b>Think of it as:</b> {c.analogy}
            </p>
          )}
          <h4>Related</h4>
          <div className="chips">
            {c.related.map((r) => (
              <button key={r} className="chip" onClick={() => set('glossary', r)}>
                {CONCEPTS[r].title}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <input type="text" placeholder="Search terms…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search glossary" />
          <div className="gl-list">
            {list.map((x) => (
              <button key={x.id} className="gl-item" onClick={() => set('glossary', x.id)}>
                <b>{x.title}</b>
                <span>{x.short}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
