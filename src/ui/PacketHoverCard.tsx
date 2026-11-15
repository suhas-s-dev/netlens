import { explainPacket } from '../learn/explain';
import { PACKET_COLORS } from '../render/colors';
import { sim, useSim } from '../state/sim';

/** Follows the pointer over a moving packet: what it is and why it exists. */
export function PacketHoverCard() {
  const hover = useSim((s) => s.hover);
  if (!hover) return null;
  const tx = sim.packets.get(hover.id);
  if (!tx) return null;
  const story = explainPacket(tx, sim.explainCtx);
  const left = Math.min(hover.x + 16, window.innerWidth - 300);
  const top = Math.min(hover.y + 16, window.innerHeight - 160);
  return (
    <div className="hover-card" style={{ left, top, borderColor: PACKET_COLORS[tx.cls] }} role="tooltip">
      <div className="hc-title" style={{ color: PACKET_COLORS[tx.cls] }}>
        {story.title}
      </div>
      <div>{story.say}</div>
      <div className="hc-foot">{tx.size} bytes · click it to pause and open its headers</div>
    </div>
  );
}
