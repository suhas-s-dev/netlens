/**
 * Guided lessons. Each step can wait for a real engine event (`when`): the sim plays until
 * that event happens, pauses exactly there, flies the camera to the device and explains.
 * Tests replay each preset and assert every trigger fires, in order.
 */
import type { TraceEvent } from '../engine';
import type { ConceptId } from './concepts';

export interface Quiz {
  q: string;
  options: string[];
  answer: number;
  explain: string;
}

export interface LessonStep {
  title: string;
  body: string;
  when?: (e: TraceEvent) => boolean;
  focus?: string;
  concept?: ConceptId;
  quiz?: Quiz;
}

export interface Lesson {
  presetId: string;
  title: string;
  summary: string;
  steps: LessonStep[];
}

const on =
  (node: string, type: TraceEvent['type'], test: (e: TraceEvent) => boolean = () => true) =>
  (e: TraceEvent) =>
    e.node === node && e.type === type && test(e);
const action = (a: string) => (e: TraceEvent) => e.type === 'decision' && e.action === a;
const reason = (r: string) => (e: TraceEvent) => e.type === 'drop' && e.reason === r;
const status = (st: string) => (e: TraceEvent) => e.type === 'app' && e.status === st;
const text = (re: RegExp) => (e: TraceEvent) => re.test(e.text);
const all =
  (...fs: ((e: TraceEvent) => boolean)[]) =>
  (e: TraceEvent) =>
    fs.every((f) => f(e));

const singleLan: Lesson = {
  presetId: 'single-lan',
  title: 'How a switch learns',
  summary: 'Follow one ping across a LAN: ARP, flooding, MAC learning, and why the second ping is twice as fast.',
  steps: [
    {
      title: 'Meet the LAN',
      body: 'Three computers (H1, H2, H3) plug into one switch, SW1. They share one network, 10.0.0.0/24. H1 is about to ping H3 at 10.0.0.30. Nobody has talked yet, so every table is empty. Press Continue and watch.',
      concept: 'switch',
    },
    {
      title: 'H1 has a problem',
      body: "H1 knows H3's IP address but not its MAC address, and an Ethernet frame can't be sent without one. Its ARP cache is empty, so it parks the ping in a queue and will ask the whole LAN.",
      when: on('h1', 'table', (e) => e.type === 'table' && e.op === 'pending'),
      focus: 'h1',
      concept: 'arp',
    },
    {
      title: 'Broadcast → flood',
      body: 'The ARP request is addressed to ff:ff:ff:ff:ff:ff (everyone). SW1 copies it out of every other port. It also just learned something: H1\'s MAC lives behind port 1. Check its MAC table on the right.',
      when: on('sw1', 'decision', action('flood')),
      focus: 'sw1',
      concept: 'flooding',
      quiz: {
        q: 'SW1 floods the request out ports 2 and 3. Why not port 1?',
        options: ['Port 1 is broken', 'That is where the frame came from, so sending it back is pointless', 'Port 1 is reserved for routers'],
        answer: 1,
        explain: 'A switch never sends a frame back out its ingress port: H1 already has it.',
      },
    },
    {
      title: 'Not for me',
      body: "H2 receives a copy, but it is asking for 10.0.0.30 and H2 is 10.0.0.20. H2 ignores it. That's the cost of broadcasts: everyone has to look.",
      when: on('h2', 'drop', reason('not-for-me')),
      focus: 'h2',
      concept: 'broadcast',
    },
    {
      title: '"That\'s me!"',
      body: "H3 recognises its own IP. It also learns H1's MAC from the request (free information!) and replies directly to H1. The reply is unicast, not a broadcast.",
      when: on('h3', 'decision', all(action('reply'), text(/ARP/))),
      focus: 'h3',
      concept: 'arp',
    },
    {
      title: 'No more flooding',
      body: 'The reply is addressed to H1\'s MAC. SW1 learned in step 3 that H1 is on port 1, so it forwards out port 1 only.',
      when: on('sw1', 'decision', action('forward')),
      focus: 'sw1',
      concept: 'mac-table',
      quiz: {
        q: "Will H2 receive a copy of H3's ARP reply?",
        options: ['Yes, switches copy everything to everyone', "No: SW1 knows H1's port, so it forwards only there"],
        answer: 1,
        explain: 'Known unicast goes out exactly one port. Flooding only happens for broadcasts and unknown destinations.',
      },
    },
    {
      title: 'Ping #1 answered',
      body: 'H1 got the MAC, sent the queued ping, and H3 answered. Look at the time: about 16.6 ms. Part of that was ARP.',
      when: on('h1', 'app', status('reply')),
      focus: 'h1',
      concept: 'ping',
    },
    {
      title: 'Ping #2: twice as fast',
      body: 'The second ping took about 8.3 ms, half the first. Why? H1 already had H3 in its ARP cache (and SW1 knew both ports): no ARP, no flooding.',
      when: on('h1', 'app', all(status('reply'), text(/icmp_seq=2/))),
      focus: 'h1',
      concept: 'arp-cache',
    },
    {
      title: 'H2 joins in',
      body: 'Now H2 pings H1.',
      when: on('h2', 'app', status('start')),
      focus: 'h2',
      quiz: {
        q: "Does H2 already know H1's MAC address?",
        options: ['Yes, it saw H1\'s ARP request earlier', 'No: that request was not for H2, so H2 did not store anything. It must ARP itself'],
        answer: 1,
        explain: 'ARP only adds a new entry when you are the target (RFC 826). Bystanders only refresh entries they already have.',
      },
    },
    {
      title: 'You did it',
      body: 'You saw ARP broadcasts, flooding, MAC learning, unicast forwarding and caching. Click SW1 to see its full MAC table: one entry per host. Entries age out after 5 minutes of silence.',
      when: on('h2', 'app', status('done')),
      focus: 'sw1',
      concept: 'mac-table',
    },
  ],
};

const twoLans: Lesson = {
  presetId: 'two-lans',
  title: 'Crossing a router',
  summary: 'Why a host sends to its gateway, why ARP never crosses a router, and how IP stays the same while MACs change.',
  steps: [
    {
      title: 'Two networks',
      body: 'LAN A is 10.0.1.0/24 (H1, H2). LAN B is 10.0.2.0/24 (H3, H4). Router R1 has one interface in each. H1 is about to ping H3.',
      concept: 'router',
    },
    {
      title: 'Is it local?',
      body: 'H1 compares 10.0.2.15 with its own network 10.0.1.0/24 using the mask. Different network, so H1 will not try to reach H3 directly: it hands the packet to its default gateway, 10.0.1.1 (R1).',
      when: on('h1', 'decision', text(/default gateway/)),
      focus: 'h1',
      concept: 'gateway',
      quiz: {
        q: 'Which MAC address will H1 put in the Ethernet destination field?',
        options: ["H3's MAC", "R1's eth0 MAC (the gateway)", 'ff:ff:ff:ff:ff:ff'],
        answer: 1,
        explain: "The IP destination stays H3, but the frame only travels to the next hop on this LAN: the gateway.",
      },
    },
    {
      title: 'ARP for the gateway',
      body: 'Notice who H1 asks for: "who has 10.0.1.1?", the router, not H3. ARP only works inside one LAN.',
      when: on('h1', 'decision', text(/broadcasting ARP request/)),
      focus: 'h1',
      concept: 'arp',
    },
    {
      title: 'The routing decision',
      body: "R1 receives a frame addressed to its MAC, strips the Ethernet header, and looks at the IP destination 10.0.2.15. Its routing table has a connected route 10.0.2.0/24 on eth1: that's the way.",
      when: on('r1', 'decision', action('lpm')),
      focus: 'r1',
      concept: 'routing-table',
    },
    {
      title: 'TTL goes down',
      body: 'Before forwarding, R1 decrements the TTL from 64 to 63 and recomputes the header checksum.',
      when: on('r1', 'decision', action('ttl')),
      focus: 'r1',
      concept: 'ttl',
      quiz: {
        q: 'When R1 forwards the packet, does the source IP change to R1\'s address?',
        options: ['Yes, routers rewrite the source IP', 'No: IP addresses stay end to end; only the Ethernet MACs are replaced'],
        answer: 1,
        explain: 'Without NAT, the IP header keeps 10.0.1.10 → 10.0.2.15 all the way. Each hop gets a new Ethernet frame.',
      },
    },
    {
      title: 'ARP, round two',
      body: 'On LAN B, R1 needs H3\'s MAC. So the router itself broadcasts "who has 10.0.2.15?" out of eth1.',
      when: on('r1', 'decision', text(/broadcasting ARP request/)),
      focus: 'r1',
      concept: 'arp',
    },
    {
      title: 'Broadcasts stay home',
      body: "SW2 floods R1's request inside LAN B. Nothing in LAN A sees it: a router is the edge of a broadcast domain.",
      when: on('sw2', 'decision', action('flood')),
      focus: 'sw2',
      concept: 'broadcast',
    },
    {
      title: 'Reply, TTL 63',
      body: 'H1 got its answer. The reply shows ttl=63: H3 sent it with 64, and one router (R1) decremented it.',
      when: on('h1', 'app', status('reply')),
      focus: 'h1',
      concept: 'ttl',
    },
    {
      title: 'Same subnet, no router',
      body: 'Now H2 (10.0.1.11) pings H1 (10.0.1.10). Same network: H2 will ARP for H1 directly, and R1 is not involved at all.',
      when: on('h2', 'app', status('start')),
      focus: 'h2',
      concept: 'subnet',
    },
    {
      title: 'Recap',
      body: 'Local destination: ARP for the host. Remote destination: ARP for the gateway. Routers swap the Ethernet frame, decrement TTL and keep the IP addresses. Click R1 to see both its routing table and its two ARP caches.',
      when: on('h2', 'app', status('done')),
      focus: 'r1',
      concept: 'router',
    },
  ],
};

const routerChain: Lesson = {
  presetId: 'router-chain',
  title: 'Traceroute & routing tables',
  summary: 'Watch traceroute map the path with TTL, see longest-prefix match pick a route, and what happens with no route.',
  steps: [
    {
      title: 'Three routers in a row',
      body: 'H1 (10.0.1.10) and H2 (10.0.3.10) are three routers apart. Each router has static routes. R1 only has a default route (0.0.0.0/0) pointing at R2. Click R1 to see it. H1 is about to run traceroute to H2.',
      focus: 'r1',
      concept: 'routing-table',
    },
    {
      title: 'Probe with TTL 1',
      body: 'Traceroute sends an ordinary ping, but with TTL = 1. It is designed to die at the first router.',
      when: on('h1', 'app', status('start')),
      focus: 'h1',
      concept: 'traceroute',
    },
    {
      title: 'Death at hop 1',
      body: "R1 would have to decrement TTL 1 to 0, so it drops the packet and sends ICMP Time Exceeded back, from its own address 10.0.1.1. That reply is how H1 learns who hop 1 is.",
      when: on('r1', 'drop', reason('ttl-expired')),
      focus: 'r1',
      concept: 'ttl',
      quiz: {
        q: 'After three probes to hop 1, what TTL will traceroute use next?',
        options: ['1 again', '2', '64'],
        answer: 1,
        explain: 'TTL 2 survives R1 (2 → 1) and dies at R2, revealing hop 2.',
      },
    },
    {
      title: 'Hop 1 found',
      body: 'Three probes, three answers from 10.0.1.1. The first one was slower because H1 had to ARP for its gateway.',
      when: on('h1', 'app', status('hop')),
      focus: 'h1',
      concept: 'traceroute',
    },
    {
      title: 'Hop 2',
      body: "TTL 2 crossed R1 and died at R2, which answers from 10.0.12.2, its interface facing back towards H1.",
      when: on('r2', 'drop', reason('ttl-expired')),
      focus: 'r2',
      concept: 'ttl',
    },
    {
      title: 'Longest prefix wins',
      body: "R3 looks up 10.0.3.10. Two routes match: 10.0.0.0/16 (static) and 10.0.3.0/24 (connected). It picks the /24.",
      when: on('r3', 'decision', all(action('lpm'), text(/also matched/))),
      focus: 'r3',
      concept: 'lpm',
      quiz: {
        q: 'Why does 10.0.3.0/24 beat 10.0.0.0/16?',
        options: ['It was added first', 'A longer prefix is more specific, and the most specific match wins', 'Connected routes always win, whatever the prefix'],
        answer: 1,
        explain: 'Longest-prefix match: /24 describes the destination more precisely than /16. (Connected vs static only breaks ties of equal length.)',
      },
    },
    {
      title: 'Destination reached',
      body: 'With TTL 4 the probe reaches H2 itself, which answers with a normal Echo Reply. Traceroute stops: 4 hops.',
      when: on('h1', 'app', all(status('hop'), text(/10\.0\.3\.10/))),
      focus: 'h1',
      concept: 'traceroute',
    },
    {
      title: 'Nowhere to go',
      body: 'Now H1 pings 10.0.99.1. R1 forwarded it using its default route. But R2 has no route for 10.0.99.0 and no default route, so it drops the packet.',
      when: on('r2', 'drop', reason('no-route')),
      focus: 'r2',
      concept: 'unreachable',
      quiz: {
        q: 'Why did R1 forward a packet for 10.0.99.1 at all?',
        options: ['R1 has a specific route to 10.0.99.0', 'R1 has a default route, 0.0.0.0/0, which matches every address'],
        answer: 1,
        explain: '0.0.0.0/0 has a prefix length of 0: it matches everything, and is used when nothing more specific does.',
      },
    },
    {
      title: 'Recap',
      body: 'TTL turns a ping into a path-mapping tool; routers report errors with ICMP; the most specific route wins; and a missing route ends in "Destination Net Unreachable". Try editing a route in Edit mode and run it again.',
      when: on('h1', 'app', status('error')),
      focus: 'h1',
      concept: 'icmp',
    },
  ],
};

const mtuBottleneck: Lesson = {
  presetId: 'mtu-bottleneck',
  title: 'Too big for the pipe',
  summary: 'MTU, fragmentation (the 4404-byte exercise, live), DF and "Fragmentation Needed", path-MTU discovery and MTR.',
  steps: [
    {
      title: 'A narrow link',
      body: 'Both LANs are normal Ethernet (MTU 1500), but the WAN link between R1 and R2 only carries 1400-byte packets. H1 is about to send a ping with 4376 bytes of data: a 4404-byte IP packet (4376 + 8 ICMP + 20 IP).',
      concept: 'mtu',
    },
    {
      title: 'Fragmenting at the source',
      body: "4404 bytes won't fit H1's own 1500-byte MTU, so H1 fragments before sending. Each piece can carry 1500 - 20 = 1480 data bytes: 1480 + 1480 + 1424 = 4384. Click a pink fragment to see its header.",
      when: on('h1', 'decision', action('fragment')),
      focus: 'h1',
      concept: 'fragmentation',
      quiz: {
        q: 'The third fragment carries data bytes 2960–4383. What is its Fragment Offset field?',
        options: ['2960', '370', '3'],
        answer: 1,
        explain: 'The offset is counted in 8-byte units: 2960 / 8 = 370. (The second fragment: 1480 / 8 = 185.) MF is 1, 1, 0.',
      },
    },
    {
      title: 'Fragmenting again',
      body: "R1 must send them over the 1400-byte WAN. Even the 1500-byte fragments are too big, so R1 splits each one again: 1376 + 104 bytes, and so on. Offsets stay relative to the ORIGINAL packet: 0, 172, 185, 357, 370, 542.",
      when: on('r1', 'decision', action('fragment')),
      focus: 'r1',
      concept: 'fragmentation',
      quiz: {
        q: 'Does R1 reassemble the packet before re-fragmenting it?',
        options: ['Yes, routers rebuild the packet first', 'No: routers never reassemble; only the final destination does'],
        answer: 1,
        explain: 'Reassembly needs every piece and costs memory, so it only ever happens at the destination.',
      },
    },
    {
      title: 'Putting it back together',
      body: 'H2 collected all six fragments (same Identification, offsets covering every byte, last one with MF = 0) and rebuilt the 4404-byte packet. Had one fragment been lost, the whole packet would be lost.',
      when: on('h2', 'decision', all(action('reassemble'), text(/reassembled/))),
      focus: 'h2',
      concept: 'reassembly',
    },
    {
      title: 'And back again',
      body: 'The echo reply is just as big, so it went through the same process in reverse: H2 fragmented, R2 re-fragmented, H1 reassembled.',
      when: on('h1', 'app', status('reply')),
      focus: 'h1',
      concept: 'packet-anatomy',
    },
    {
      title: "Don't Fragment",
      body: 'Now H1 sends a 1500-byte ping with DF set. R1 is not allowed to fragment it, so it drops the packet and sends ICMP type 3 code 4, "Fragmentation Needed", with the WAN MTU (1400) in the header.',
      when: on('r1', 'drop', reason('too-big')),
      focus: 'r1',
      concept: 'df',
      quiz: {
        q: 'What does H1 learn from that ICMP message?',
        options: ['That H2 is down', 'That packets to H2 must be at most 1400 bytes', 'That R1 has no route'],
        answer: 1,
        explain: 'The message carries the next-hop MTU. Hosts cache it as the path MTU for that destination (RFC 1191).',
      },
    },
    {
      title: 'Remembering the path MTU',
      body: "H1 stores \"path MTU to 10.0.2.20 = 1400\" (click H1: it's in its panel). Its next DF packet to H2 will be sized to fit, or refused locally with \"Message too long\".",
      when: on('h1', 'table', (e) => e.type === 'table' && e.table === 'pmtu'),
      focus: 'h1',
      concept: 'pmtud',
    },
    {
      title: 'Path MTU discovery',
      body: 'H2 now discovers the path MTU on purpose: a 1500-byte DF probe, a "too big, use 1400" from R2, then a 1400-byte probe that gets through. That is how TCP finds the right packet size.',
      when: on('h2', 'app', (e) => e.type === 'app' && e.app === 'pmtud' && e.status === 'done'),
      focus: 'h2',
      concept: 'pmtud',
    },
    {
      title: 'MTR',
      body: 'Finally H1 runs MTR: traceroute in rounds, with loss and latency per hop. Every hop shows 0% loss here. Try adding loss to the WAN link in Edit mode (link panel), then run MTR again from the left panel.',
      when: on('h1', 'app', (e) => e.type === 'app' && e.app === 'mtr' && e.status === 'done'),
      focus: 'h1',
      concept: 'mtr',
    },
  ],
};

export const LESSONS: Record<string, Lesson> = {
  [singleLan.presetId]: singleLan,
  [twoLans.presetId]: twoLans,
  [routerChain.presetId]: routerChain,
  [mtuBottleneck.presetId]: mtuBottleneck,
};
