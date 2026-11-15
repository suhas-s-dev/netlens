import type { NodeType, PacketClass } from '../engine';

export const PACKET_COLORS: Record<PacketClass, string> = {
  arp: '#ffb020',
  'icmp-request': '#4da3ff',
  'icmp-reply': '#3ddc97',
  'icmp-error': '#ff4d6d',
  fragment: '#f472b6',
  ipv4: '#b388ff',
  other: '#9aa4b2',
};

export const PACKET_LABELS: Record<PacketClass, string> = {
  arp: 'ARP',
  'icmp-request': 'ICMP echo request',
  'icmp-reply': 'ICMP echo reply',
  'icmp-error': 'ICMP error',
  fragment: 'IP fragment',
  ipv4: 'IPv4',
  other: 'Other',
};

export const DEVICE_COLORS: Record<NodeType, { body: string; accent: string }> = {
  host: { body: '#2b3646', accent: '#7dd3fc' },
  switch: { body: '#24323a', accent: '#5eead4' },
  router: { body: '#352c45', accent: '#c4b5fd' },
};
