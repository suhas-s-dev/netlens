import { describe, expect, it } from 'vitest';
import { Engine, SEC, type TopologyJson, type TraceEvent, type TxEvent } from '../../engine';
import routerChain from '../../presets/router-chain.json';
import singleLan from '../../presets/single-lan.json';
import twoLans from '../../presets/two-lans.json';
import mtuBottleneck from '../../presets/mtu-bottleneck.json';
import tcpUdp from '../../presets/tcp-udp.json';
import { CONCEPT_LIST, CONCEPTS } from '../concepts';
import { buildCtx, explain, explainPacket } from '../explain';
import { LESSONS } from '../lessons';

const presets: [string, TopologyJson][] = [
  ['single-lan', singleLan as TopologyJson],
  ['two-lans', twoLans as TopologyJson],
  ['router-chain', routerChain as TopologyJson],
  ['mtu-bottleneck', mtuBottleneck as TopologyJson],
  ['tcp-udp', tcpUdp as TopologyJson],
];

function run(t: TopologyJson) {
  const engine = new Engine(t, { seed: t.seed });
  const events: TraceEvent[] = [];
  const packets = new Map<string, TxEvent>();
  engine.on((e) => {
    events.push(e);
    if (e.type === 'tx') packets.set(e.packetId!, e);
  });
  engine.runUntil(t.name === 'MTU bottleneck' ? 14 * SEC : 20 * SEC);
  return { events, ctx: buildCtx(t, packets) };
}

describe.each(presets)('explanations for %s', (_, topo) => {
  const { events, ctx } = run(topo);

  it('every event gets a sensible explanation', () => {
    for (const e of events) {
      const x = explain(e, ctx);
      expect(x.say.length, e.text).toBeGreaterThan(5);
      expect(x.say, e.text).not.toMatch(/undefined|null|NaN/);
      if (x.concept) expect(CONCEPTS[x.concept], x.concept).toBeDefined();
    }
  });

  it('key moments are re-phrased for learners, not copied from the engine', () => {
    const key = events.map((e) => ({ e, x: explain(e, ctx) })).filter(({ x }) => x.weight === 'key');
    expect(key.length).toBeGreaterThan(10);
    for (const { e, x } of key) if (e.type !== 'app' || e.status === 'reply') expect(x.say).not.toBe(e.text);
  });

  it('every packet gets a story with device names', () => {
    for (const e of events) if (e.type === 'tx') expect(explainPacket(e, ctx).say).toMatch(/[HRS]W?\d/);
    for (const e of events) if (e.type === 'tx') expect(explainPacket(e, ctx).say).not.toMatch(/undefined|NaN/);
  });
});

describe('specific explanations', () => {
  const { events, ctx } = run(singleLan as TopologyJson);
  const says = events.map((e) => explain(e, ctx).say);
  it('names devices instead of raw MACs', () => {
    expect(says).toContain("New entry! Frames from H1's MAC arrive on port 1, so that's where it lives.");
    expect(says.some((s) => s.startsWith("I know H1's MAC is on port 1"))).toBe(true);
    expect(says).toContain('Shouting to the whole LAN: "Who has 10.0.0.30? Tell me!"');
  });
});

describe.each(Object.values(LESSONS))('lesson $presetId', (lesson) => {
  it('every step trigger fires, in order, during the preset scenario', () => {
    const topo = presets.find(([id]) => id === lesson.presetId)![1];
    const { events } = run(topo);
    let i = 0;
    let step = 0;
    for (; step < lesson.steps.length; step++) {
      const when = lesson.steps[step]!.when;
      if (!when) continue;
      while (i < events.length && !when(events[i]!)) i++;
      expect(i, `step ${step} "${lesson.steps[step]!.title}" never triggered`).toBeLessThan(events.length);
      i++;
    }
  });

  it('quizzes are well-formed and concepts exist', () => {
    for (const s of lesson.steps) {
      if (s.concept) expect(CONCEPTS[s.concept]).toBeDefined();
      if (s.quiz) {
        expect(s.quiz.answer).toBeLessThan(s.quiz.options.length);
        expect(s.quiz.explain.length).toBeGreaterThan(10);
      }
    }
  });
});

describe('glossary', () => {
  it('related links resolve', () => {
    for (const c of CONCEPT_LIST) for (const r of c.related) expect(CONCEPTS[r], `${c.id} → ${r}`).toBeDefined();
  });
});
