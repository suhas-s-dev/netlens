import { PACKET_COLORS, PACKET_LABELS } from '../render/colors';

export function Legend() {
  const keys = ['arp', 'icmp-request', 'icmp-reply', 'icmp-error'] as const;
  return (
    <div className="overlay card legend" aria-label="Packet colours">
      {keys.map((k) => (
        <span key={k}>
          <i style={{ background: PACKET_COLORS[k] }} />
          {PACKET_LABELS[k]}
        </span>
      ))}
    </div>
  );
}
