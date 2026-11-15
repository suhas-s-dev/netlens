import { describe, expect, it } from 'vitest';
import { MS, SEC } from '../core/time';
import type { Switch } from '../devices/Switch';
import type { SwitchState } from '../devices/state';
import type { Frame } from '../model/frame';
import type { EthernetFrame } from '../protocols/types';
import type { DecisionEvent, TxEvent } from '../trace/events';
import { lanTopology, make, texts } from './helpers';

const MAC = (n: number) => `02:00:00:00:0${n}:01`;

function inject(engine: ReturnType<typeof make>['engine'], port: string, src: string, dst: string): void {
  const sw = engine.devices.get('sw1') as Switch;
  const eth: EthernetFrame = { dst, src, etherType: 0x88b5, payload: { kind: 'raw', bytes: new Uint8Array(46) } };
  const frame: Frame = { id: engine.newFrameId(), flowId: engine.newFlowId(), eth };
  sw.receive(sw.ports.get(port)!, frame);
  engine.runFor(10 * MS); // let egress queues drain so every copy is transmitted
}

function egress(events: ReturnType<typeof make>['events']): string[] {
  return events.filter((e): e is TxEvent => e.type === 'tx' && e.node === 'sw1').map((e) => e.iface);
}

describe('L2 switch', () => {
  it('learns the source MAC on the ingress port', () => {
    const { engine, events } = make(lanTopology(3));
    inject(engine, '1', MAC(1), 'ff:ff:ff:ff:ff:ff');
    expect(texts(events)).toContain(`SW1 learned ${MAC(1)} on port 1`);
    expect((engine.getState('sw1') as SwitchState).mac).toEqual([{ mac: MAC(1), port: '1', expiresIn: 300 * SEC - 10 * MS }]);
  });

  it('floods broadcast out every linked port except the ingress port', () => {
    const { engine, events } = make(lanTopology(3)); // ports 1-3 linked, port 4 unlinked
    inject(engine, '2', MAC(2), 'ff:ff:ff:ff:ff:ff');
    expect(texts(events)).toContain('SW1 flooding broadcast frame out ports 1,3');
    expect(egress(events).sort()).toEqual(['1', '3']);
  });

  it('floods unknown unicast (never out the ingress port), then forwards known unicast out one port', () => {
    const { engine, events } = make(lanTopology(3));
    inject(engine, '1', MAC(1), MAC(3));
    expect(texts(events)).toContain(`SW1 flooding unknown unicast to ${MAC(3)} out ports 2,3`);
    expect(egress(events).sort()).toEqual(['2', '3']);

    events.length = 0;
    inject(engine, '3', MAC(3), MAC(1)); // learn MAC(3) on port 3; MAC(1) is known on port 1
    expect(egress(events)).toEqual(['1']);
    const fwd = events.find((e): e is DecisionEvent => e.type === 'decision' && e.action === 'forward');
    expect(fwd?.ifaces).toEqual(['1']);

    events.length = 0;
    inject(engine, '1', MAC(1), MAC(3));
    expect(egress(events)).toEqual(['3']);
  });

  it('filters frames whose destination is on the ingress port', () => {
    const { engine, events } = make(lanTopology(3));
    inject(engine, '1', MAC(1), 'ff:ff:ff:ff:ff:ff');
    events.length = 0;
    inject(engine, '1', MAC(5), MAC(1));
    expect(egress(events)).toEqual([]);
    expect(texts(events)).toContain(`SW1 filtered frame to ${MAC(1)}: destination is on ingress port 1`);
  });

  it('moves an entry when a MAC appears on a different port', () => {
    const { engine, events } = make(lanTopology(3));
    inject(engine, '1', MAC(1), 'ff:ff:ff:ff:ff:ff');
    inject(engine, '2', MAC(1), 'ff:ff:ff:ff:ff:ff');
    expect(texts(events)).toContain(`SW1 moved ${MAC(1)} from port 1 to port 2`);
  });

  it('ages entries out after 300 s without traffic, and refreshes extend the lifetime', () => {
    const { engine, events } = make(lanTopology(3));
    inject(engine, '1', MAC(1), 'ff:ff:ff:ff:ff:ff');
    engine.runUntil(200 * SEC);
    inject(engine, '1', MAC(1), 'ff:ff:ff:ff:ff:ff'); // refresh at t=200 s
    engine.runUntil(301 * SEC);
    expect((engine.getState('sw1') as SwitchState).mac).toHaveLength(1);
    engine.runUntil(501 * SEC);
    expect((engine.getState('sw1') as SwitchState).mac).toHaveLength(0);
    expect(texts(events)).toContain(`SW1 aged out ${MAC(1)} on port 1 (no frames for 300.000 s)`);
  });

  it('end-to-end: ARP floods, the reply is forwarded only toward the requester', () => {
    const { engine, events } = make(lanTopology(3));
    engine.ping('h1', '10.0.0.2', { count: 1 });
    engine.runUntil(2 * SEC);
    const t = texts(events);
    expect(t).toContain('SW1 flooding broadcast frame out ports 2,3');
    expect(t).toContain(`SW1 learned ${MAC(1)} on port 1`);
    expect(t).toContain(`SW1 learned ${MAC(2)} on port 2`);
    // H3 never receives the unicast reply or the echo traffic.
    const toH3 = events.filter((e): e is TxEvent => e.type === 'tx' && e.toNode === 'h3');
    expect(toH3).toHaveLength(1);
    expect(toH3[0]!.cls).toBe('arp');
  });
});
