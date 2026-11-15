import type { TopologyJson } from '../engine';
import routerChain from './router-chain.json';
import singleLan from './single-lan.json';
import twoLans from './two-lans.json';
import mtuBottleneck from './mtu-bottleneck.json';

export interface Preset {
  id: string;
  topology: TopologyJson;
}

export const PRESETS: Preset[] = [
  { id: 'single-lan', topology: singleLan as TopologyJson },
  { id: 'two-lans', topology: twoLans as TopologyJson },
  { id: 'router-chain', topology: routerChain as TopologyJson },
  { id: 'mtu-bottleneck', topology: mtuBottleneck as TopologyJson },
];
