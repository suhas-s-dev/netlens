/** Glossary of networking concepts, written for learners. Bubbles, cards and lessons link here. */

export type ConceptId =
  | 'host'
  | 'switch'
  | 'router'
  | 'link'
  | 'port'
  | 'nic'
  | 'mac'
  | 'ip'
  | 'subnet'
  | 'gateway'
  | 'ethernet'
  | 'encapsulation'
  | 'broadcast'
  | 'arp'
  | 'arp-cache'
  | 'mac-table'
  | 'flooding'
  | 'aging'
  | 'routing-table'
  | 'lpm'
  | 'ttl'
  | 'checksum'
  | 'icmp'
  | 'ping'
  | 'traceroute'
  | 'unreachable'
  | 'serialization'
  | 'propagation';

export interface Concept {
  id: ConceptId;
  title: string;
  /** One line. */
  short: string;
  /** A few sentences. */
  body: string;
  /** Everyday analogy, optional. */
  analogy?: string;
  related: ConceptId[];
}

const C: Concept[] = [
  {
    id: 'host',
    title: 'Host',
    short: 'An end device (a laptop, phone or server) that sends and receives traffic.',
    body: 'A host has a network card with a MAC address, an IP address, a subnet mask and usually a default gateway. Hosts never forward packets for others: if a packet is not addressed to them, they drop it.',
    analogy: 'A house on a street: it sends and receives mail, but does not deliver mail for its neighbours.',
    related: ['nic', 'ip', 'gateway', 'arp-cache'],
  },
  {
    id: 'switch',
    title: 'Switch (Layer 2)',
    short: 'Connects devices in one LAN and forwards Ethernet frames by MAC address.',
    body: 'A switch only looks at the Ethernet header. It learns which MAC address lives behind which port by reading the source address of every frame. Frames to a known MAC go out one port; broadcasts and unknown destinations are flooded out every other port.',
    analogy: 'A mail-room clerk who memorises which desk each person sits at by watching who sends letters from where.',
    related: ['mac-table', 'flooding', 'mac', 'port'],
  },
  {
    id: 'router',
    title: 'Router (Layer 3)',
    short: 'Connects different IP networks and forwards packets by IP address.',
    body: 'A router has one interface (with its own IP and MAC) in each network it joins. For every packet it looks up the destination IP in its routing table, decrements the TTL, and sends the packet out of the matching interface inside a brand-new Ethernet frame.',
    analogy: 'A post office sorting centre: it reads the city on the envelope and puts it on the right truck.',
    related: ['routing-table', 'lpm', 'ttl', 'gateway'],
  },
  {
    id: 'link',
    title: 'Link',
    short: 'The cable between two ports.',
    body: 'Sending a frame takes two kinds of time: serialization (pushing every bit onto the wire, longer for big frames and slow links) and propagation (the signal travelling the length of the cable). Links here are full duplex: both directions can carry traffic at once.',
    related: ['serialization', 'propagation', 'port'],
  },
  {
    id: 'port',
    title: 'Port / interface',
    short: 'Where a cable plugs into a device.',
    body: 'Switch ports have no IP address: they just pass frames. Router and host interfaces each have a MAC address and an IP address. A port can only send one frame at a time; others wait in its queue.',
    related: ['link', 'nic'],
  },
  {
    id: 'nic',
    title: 'Network card (NIC)',
    short: 'Hardware that sends and receives frames, and ignores frames for other MACs.',
    body: 'Every NIC has a MAC address. When a frame arrives, the NIC checks the destination MAC: if it is not its own (and not broadcast), the frame is discarded before the computer even looks at it. That is what happens when a switch floods a frame to a host it was not meant for.',
    related: ['mac', 'flooding'],
  },
  {
    id: 'mac',
    title: 'MAC address',
    short: 'A 48-bit hardware address, like 02:00:00:00:01:01. Used inside one LAN.',
    body: 'MAC addresses identify network cards. Ethernet frames carry a source and destination MAC. They only matter within one local network: when a packet crosses a router, the MAC addresses are replaced, but the IP addresses stay the same.',
    analogy: 'The name on an apartment door: useful inside the building, meaningless in another city.',
    related: ['ip', 'ethernet', 'arp'],
  },
  {
    id: 'ip',
    title: 'IP address',
    short: 'A 32-bit logical address, like 10.0.1.10. Used end to end across networks.',
    body: 'An IPv4 address has a network part and a host part; the subnet mask (or /prefix) says where the split is. IP addresses in a packet stay the same from sender to final receiver, while the MAC addresses change at every router.',
    analogy: 'A postal address: city (network) + street number (host).',
    related: ['subnet', 'mac', 'routing-table'],
  },
  {
    id: 'subnet',
    title: 'Subnet & mask',
    short: '/24 means the first 24 bits are the network: 10.0.1.0/24 holds 10.0.1.1–10.0.1.254.',
    body: 'A host decides "is this destination local?" by comparing network parts: same network, deliver directly on the LAN; different network, hand it to the default gateway. The first address is the network itself and the last is the broadcast address.',
    related: ['ip', 'gateway'],
  },
  {
    id: 'gateway',
    title: 'Default gateway',
    short: 'The router a host sends everything to when the destination is outside its subnet.',
    body: 'A host does not know the whole internet. Its rule is simple: local subnet, deliver directly; anything else, send to the default gateway. The packet keeps the final destination IP, but the Ethernet frame is addressed to the gateway\'s MAC.',
    related: ['subnet', 'router', 'arp'],
  },
  {
    id: 'ethernet',
    title: 'Ethernet frame',
    short: 'The Layer 2 envelope: destination MAC, source MAC, type, then the payload.',
    body: 'Every packet on a cable travels inside an Ethernet frame. The Type field says what is inside (0x0800 = IPv4, 0x0806 = ARP). Frames shorter than 60 bytes are padded with zeros; on the wire a 4-byte checksum (FCS) is added.',
    related: ['encapsulation', 'mac'],
  },
  {
    id: 'encapsulation',
    title: 'Encapsulation (layers)',
    short: 'Each layer wraps the one above: Ethernet ⟶ IPv4 ⟶ ICMP.',
    body: 'An application message is wrapped in a transport/ICMP header, then an IP header (end-to-end addresses), then an Ethernet header (next-hop MAC addresses). Routers unwrap the Ethernet layer, look at the IP layer, and wrap it in a new Ethernet frame for the next link.',
    analogy: 'A letter in an envelope inside a courier bag: the courier only reads the bag label.',
    related: ['ethernet', 'ip', 'icmp'],
  },
  {
    id: 'broadcast',
    title: 'Broadcast',
    short: 'A frame to ff:ff:ff:ff:ff:ff is delivered to every device on the LAN.',
    body: 'Broadcasts are how a device talks to "everyone here" when it does not know who to ask, which is exactly what ARP needs. Switches flood broadcasts; routers never forward them, which is why a router marks the edge of a broadcast domain.',
    related: ['arp', 'flooding'],
  },
  {
    id: 'arp',
    title: 'ARP',
    short: 'Address Resolution Protocol: "who has IP X? tell me your MAC."',
    body: 'To send an IP packet on a LAN, a device needs the next hop\'s MAC address. ARP broadcasts a request; the device with that IP replies directly (unicast) with its MAC. Both sides remember the answer in their ARP cache. Packets wait in a queue while ARP is in progress.',
    analogy: 'Shouting "Who here is Sam?" in an office, and Sam walking over to say "me, desk 4".',
    related: ['arp-cache', 'broadcast', 'mac'],
  },
  {
    id: 'arp-cache',
    title: 'ARP cache',
    short: 'A host or router\'s memory of IP → MAC answers.',
    body: 'Entries are added from ARP replies (and from requests aimed at you), used for every packet sent, and expire after a timeout (60 s here) so stale answers do not linger. An "incomplete" entry means a request is in flight.',
    related: ['arp', 'aging'],
  },
  {
    id: 'mac-table',
    title: 'MAC address table',
    short: 'A switch\'s map of MAC address → port, learned from source addresses.',
    body: 'Whenever a frame arrives, the switch records "this source MAC is reachable through this port". When a frame must go to that MAC later, it is sent out that one port only. Unknown destinations are flooded. Entries age out after 300 s of silence.',
    related: ['switch', 'flooding', 'aging'],
  },
  {
    id: 'flooding',
    title: 'Flooding',
    short: 'Sending a copy out of every port except the one it arrived on.',
    body: 'A switch floods broadcasts, and unicast frames to MACs it has not learned yet. Never sending back out the ingress port prevents echoing the frame to its sender. Devices that receive a flooded frame that is not theirs simply discard it.',
    related: ['switch', 'broadcast', 'mac-table'],
  },
  {
    id: 'aging',
    title: 'Aging',
    short: 'Table entries expire if not refreshed, so devices adapt when things move.',
    body: 'If a laptop moves to another port, or disappears, old entries would send traffic to the wrong place. Timers fix that: switch MAC entries last 300 s since the last frame, ARP entries 60 s.',
    related: ['mac-table', 'arp-cache'],
  },
  {
    id: 'routing-table',
    title: 'Routing table',
    short: 'A router\'s list of "network → which interface / next router".',
    body: 'Connected routes (C) are created automatically for each interface\'s subnet. Static routes (S) are added by an administrator: "to reach 10.0.3.0/24, send to 10.0.23.2". 0.0.0.0/0 is the default route: it matches everything.',
    related: ['lpm', 'router'],
  },
  {
    id: 'lpm',
    title: 'Longest-prefix match',
    short: 'When several routes match, the most specific one (longest /prefix) wins.',
    body: '10.0.3.10 matches 0.0.0.0/0, 10.0.0.0/16 and 10.0.3.0/24 at the same time. The router picks /24 because it describes the destination most precisely. The default route only wins when nothing more specific matches.',
    related: ['routing-table'],
  },
  {
    id: 'ttl',
    title: 'TTL (time to live)',
    short: 'A hop counter in the IP header. Every router subtracts 1; at 0 the packet dies.',
    body: 'TTL stops packets circling forever if routes form a loop. When a router would forward a packet with TTL 1, it drops it and sends an ICMP Time Exceeded message back to the sender. Traceroute uses exactly this to discover each router on the path.',
    related: ['traceroute', 'icmp', 'checksum'],
  },
  {
    id: 'checksum',
    title: 'Header checksum',
    short: 'A 16-bit sum that lets receivers detect corrupted headers.',
    body: 'The IPv4 header checksum covers the header only. Because a router changes the TTL, it must recompute the checksum on every hop. ICMP has its own checksum over the whole ICMP message.',
    related: ['ttl', 'ip'],
  },
  {
    id: 'icmp',
    title: 'ICMP',
    short: 'The IP layer\'s control and error messages (ping, Time Exceeded, Unreachable).',
    body: 'Echo request/reply (types 8/0) power ping. Routers report problems with errors such as Time Exceeded (11) or Destination Unreachable (3). An error quotes the start of the packet that caused it, so the sender can tell which one failed.',
    related: ['ping', 'traceroute', 'unreachable'],
  },
  {
    id: 'ping',
    title: 'Ping',
    short: 'Sends ICMP echo requests and times the echo replies.',
    body: 'Ping answers "can I reach that address, and how long does a round trip take?". The first ping is often slower because ARP has to run first.',
    related: ['icmp', 'arp'],
  },
  {
    id: 'traceroute',
    title: 'Traceroute',
    short: 'Discovers every router on the path by sending probes with TTL 1, 2, 3…',
    body: 'A probe with TTL 1 dies at the first router, which replies "Time Exceeded" from its own address: that is hop 1. TTL 2 reveals hop 2, and so on until the destination itself answers.',
    related: ['ttl', 'icmp'],
  },
  {
    id: 'unreachable',
    title: 'Destination unreachable',
    short: 'ICMP error: "I can\'t get this packet any further."',
    body: 'Net unreachable means the router has no route to the destination network. Host unreachable means the network is right but nobody answered ARP for that address.',
    related: ['icmp', 'routing-table', 'arp'],
  },
  {
    id: 'serialization',
    title: 'Serialization delay',
    short: 'Time to push all the bits of a frame onto the wire: size ÷ bandwidth.',
    body: 'A 1500-byte frame on a 10 Mb/s link takes 1.2 ms just to transmit; a 64-byte one takes 0.05 ms. In the 3D view, a packet\'s streak length is its serialization time.',
    related: ['propagation', 'link'],
  },
  {
    id: 'propagation',
    title: 'Propagation delay',
    short: 'Time for the signal to travel the length of the cable.',
    body: 'It depends on distance, not on frame size: about 5 µs per kilometre of fibre. Links here default to 2 ms so you can watch packets travel.',
    related: ['serialization', 'link'],
  },
];

export const CONCEPTS: Record<ConceptId, Concept> = Object.fromEntries(C.map((c) => [c.id, c])) as Record<ConceptId, Concept>;
export const CONCEPT_LIST = C;
