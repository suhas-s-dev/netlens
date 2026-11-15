import { CONCEPTS } from '../../learn/concepts';
import { exitLesson, nextStep, pickAnswer, useLesson } from '../../state/lesson';
import { useSim } from '../../state/sim';

/** The lesson step card, docked at the top of the scene. */
export function LessonCard() {
  const { lesson, step, phase, picked } = useLesson();
  const set = useSim((s) => s.set);
  if (!lesson) return null;
  const s = lesson.steps[step]!;
  const total = lesson.steps.length;
  const last = step === total - 1;

  if (phase === 'wait') {
    return (
      <div className="overlay card lesson-card waiting" role="status">
        <div className="lc-head">
          <span className="pixel">{lesson.title}</span>
          <span className="lc-step">
            {step + 1}/{total}
          </span>
        </div>
        <div className="lc-wait">
          <span className="spinner" /> Watching for the next moment… ({s.title})
        </div>
        <button className="btn" onClick={exitLesson}>
          Exit lesson
        </button>
      </div>
    );
  }

  const answered = picked !== null;
  const correct = s.quiz && picked === s.quiz.answer;
  return (
    <div className="overlay card lesson-card" role="dialog" aria-label={`Lesson step: ${s.title}`}>
      <div className="lc-head">
        <span className="pixel">{lesson.title}</span>
        <span className="lc-step">
          {step + 1}/{total}
        </span>
      </div>
      <div className="lc-progress">
        <div style={{ width: `${((step + 1) / total) * 100}%` }} />
      </div>
      <h3>{s.title}</h3>
      <p>{s.body}</p>
      {s.quiz && (
        <div className="quiz">
          <div className="q">
            <span className="pixel">Quick check</span> {s.quiz.q}
          </div>
          {s.quiz.options.map((o, i) => (
            <button
              key={i}
              className={`opt ${answered && i === s.quiz!.answer ? 'right' : ''} ${answered && i === picked && i !== s.quiz!.answer ? 'wrong' : ''}`}
              onClick={() => pickAnswer(i)}
              disabled={answered}
            >
              {o}
            </button>
          ))}
          {answered && <div className={`verdict ${correct ? 'right' : 'wrong'}`}>{correct ? 'Correct! ' : 'Not quite. '}{s.quiz.explain}</div>}
        </div>
      )}
      <div className="row">
        {s.concept && (
          <button className="btn" onClick={() => set('glossary', s.concept!)}>
            ? {CONCEPTS[s.concept].title}
          </button>
        )}
        <span className="grow" />
        <button className="btn" onClick={exitLesson}>
          Exit
        </button>
        <button className="btn primary" onClick={nextStep} disabled={!!s.quiz && !answered}>
          {last ? 'Finish ✓' : step === 0 ? 'Start ▶' : 'Continue ▶'}
        </button>
      </div>
    </div>
  );
}
