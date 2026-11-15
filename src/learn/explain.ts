/**
 * Turns engine trace events into learner-facing explanations: a first-person line for the
 * device's speech bubble, a "why", and the concept it illustrates.
 *
 * The engine stays the source of truth: this module only re-phrases what the engine
 * decided, using the structured fields of each event (and the engine's own wording,
 * which is snapshot-tested, for the few values not carried as fields).
 */
import { generatedMac, isGroupMac, type TopologyJson, type TraceEvent, type TxEvent } from '../engine';
import type { ConceptId } from './concepts';

export type Tone = 'info' | 'good' | 'warn' | 'bad' | 'muted';

export interface Explanation {
  /** First person, from the device's point of view. */
  say: string;
  why?: string;
  concept?: ConceptId;
  /** key = worth a speech bubble; minor = log only. */
  weight: 'key' | 'minor';
  tone: Tone;
}

export interface ExplainCtx {
  name(nodeId: string): string;
  /** "H3" for a MAC/IP that belongs to a device, else null. */
  macOwner(mac: string): string | null;
  ipOwner(ip: string): string | null;
  packet(id: string | undefined): TxEvent | undefined;
}

export function buildCtx(topology: TopologyJson, packets: Map<string, TxEvent>): ExplainCtx {
  const names = new Map(topology.nodes.map((n) => [n.id, n.name]));
  const macs = new Map<string, string>();
  const ips = new Map<string, string>();
  topology.nodes.forEach((n, idx) =>
    n.interfaces.forEach((i, k) => {
      const owner = n.type === 'switch' ? n.name : n.type === 'router' ? `${n.name} ${i.id}` : n.name;
      macs.set((i.mac ?? generatedMac(idx, k)).toLowerCase(), owner);
      if (i.ip) ips.set(i.ip.split('/')[0]!, n.type === 'router' ? `${n.name} (${i.id})` : n.name);
    }),
  );
  return {
    name: (id) => names.get(id) ?? id,
    macOwner: (m) => (m === 'ff:ff:ff:ff:ff:ff' ? 'everyone' : (macs.get(m.toLowerCase()) ?? null)),
    ipOwner: (ip) => ips.get(ip) ?? null,
    packet: (id) => (id ? packets.get(id) : undefined),
  };
}

const m = (re: RegExp, s: string) => re.exec(s) ?? [];

function ipLabel(ctx: ExplainCtx, ip: string | undefined): string {
  if (!ip) return 'it';
  const o = ctx.ipOwner(ip);
  return o ? `${o} (${ip})` : ip;
}

function macLabel(ctx: ExplainCtx, mac: string | undefined): string {
  if (!mac) return 'that address';
  const o = ctx.macOwner(mac);
  return o ? `${o}'s MAC` : mac;
}

export function explain(e: TraceEvent, ctx: ExplainCtx): Explanation {
  const t = e.text;
  switch (e.type) {
    case 'tx':
    case 'rx':
      return { say: t, weight: 'minor', tone: 'muted', concept: 'link' };

    case 'table': {
      if (e.table === 'mac') {
        const port = e.iface;
        if (e.op === 'add')
          return {
            say: `New entry! Frames from ${macLabel(ctx, e.key)} arrive on port ${port}, so that's where it lives.`,
            why: 'Switches learn by reading the SOURCE MAC of every frame that comes in.',
            concept: 'mac-table',
            weight: 'key',
            tone: 'good',
          };
        if (e.op === 'update')
          return { say: `${macLabel(ctx, e.key)} moved: it now shows up on port ${port}. Updating my table.`, concept: 'mac-table', weight: 'key', tone: 'warn' };
        if (e.op === 'remove')
          return { say: `Haven't heard from ${macLabel(ctx, e.key)} in 5 minutes. Forgetting it.`, why: 'Old entries expire so the table stays correct when devices move.', concept: 'aging', weight: 'key', tone: 'muted' };
        if (e.op === 'hit') return { say: `My table says ${macLabel(ctx, e.key)} is on port ${port}.`, concept: 'mac-table', weight: 'minor', tone: 'info' };
        return { say: `Still seeing ${macLabel(ctx, e.key)} on port ${port}; timer reset.`, concept: 'aging', weight: 'minor', tone: 'muted' };
      }
      if (e.table === 'arp') {
        const ip = e.key;
        if (e.op === 'pending')
          return {
            say: `I need to reach ${ipLabel(ctx, ip)} but I don't know its MAC address. Parking the packet and asking with ARP.`,
            why: 'An Ethernet frame needs a destination MAC, and IP alone is not enough to build one.',
            concept: 'arp',
            weight: 'key',
            tone: 'warn',
          };
        if (e.op === 'add') {
          const [, mac] = m(/is at (\S+)/, t);
          const via = /from ARP request/.test(t) ? 'its ARP request' : 'its ARP reply';
          return { say: `Noted: ${ipLabel(ctx, ip)} is at ${mac}. I learned that from ${via}.`, concept: 'arp-cache', weight: 'key', tone: 'good' };
        }
        if (e.op === 'update') return { say: `${ipLabel(ctx, ip)} has a new MAC. Updating my ARP cache.`, concept: 'arp-cache', weight: 'key', tone: 'warn' };
        if (e.op === 'refresh')
          return {
            say: `I overheard ${ipLabel(ctx, ip)} again, so I'm refreshing my ARP entry for it.`,
            why: 'RFC 826: if you already know the sender, update it even if the ARP was not for you.',
            concept: 'arp-cache',
            weight: 'minor',
            tone: 'muted',
          };
        if (e.op === 'hit') return { say: `ARP cache hit: I already know ${ipLabel(ctx, ip)}'s MAC, so no need to ask.`, concept: 'arp-cache', weight: 'minor', tone: 'good' };
        if (/failed/.test(t))
          return { say: `Nobody answered "who has ${ip}?" three times. Giving up.`, why: 'No device on this LAN owns that IP (or it is switched off).', concept: 'unreachable', weight: 'key', tone: 'bad' };
        return { say: `My ARP entry for ${ipLabel(ctx, ip)} expired after 60 s. I'll ask again next time.`, concept: 'aging', weight: 'key', tone: 'muted' };
      }
      if (e.table === 'pmtu') {
        const [, mtu] = m(/is (\d+)/, t);
        return {
          say: `Noted: packets to ${ipLabel(ctx, e.key)} must be at most ${mtu} bytes. I'll remember that path MTU for 10 minutes.`,
          why: 'A router told us with ICMP "Fragmentation Needed" (RFC 1191).',
          concept: 'pmtud',
          weight: 'key',
          tone: 'good',
        };
      }
      return { say: t, weight: 'minor', tone: 'info' };
    }

    case 'decision': {
      switch (e.action) {
        case 'flood': {
          const ports = e.ifaces?.join(', ') ?? '';
          const frame = ctx.packet(e.packetId)?.frame.eth;
          if (/broadcast frame/.test(t))
            return {
              say: `Broadcast! It's addressed to everyone, so I copy it out of port${(e.ifaces?.length ?? 0) > 1 ? 's' : ''} ${ports}, but never back where it came from.`,
              why: 'Broadcasts (ff:ff:ff:ff:ff:ff) go to every device on the LAN.',
              concept: 'flooding',
              weight: 'key',
              tone: 'warn',
            };
          return {
            say: `I've never seen ${macLabel(ctx, frame?.dst)} send anything, so I don't know its port. Flooding out ${ports} to be safe.`,
            why: 'Unknown unicast is flooded; the right device keeps it and the others discard it.',
            concept: 'flooding',
            weight: 'key',
            tone: 'warn',
          };
        }
        case 'forward': {
          const frame = ctx.packet(e.packetId)?.frame.eth;
          return {
            say: `I know ${macLabel(ctx, frame?.dst)} is on port ${e.ifaces?.[0]}, so it goes there and only there.`,
            why: 'Known unicast is forwarded out a single port: no flooding.',
            concept: 'mac-table',
            weight: 'key',
            tone: 'good',
          };
        }
        case 'lpm': {
          const [, dst, prefix, iface, how] = m(/LPM: (\S+) matched (\S+) via (\S+) \(([^)]*)\)/, t);
          const also = m(/also matched (.*)$/, t)[1];
          return {
            say: `Packet for ${dst}. Best match in my routing table: ${prefix} → out ${iface}${how?.startsWith('static') ? ` (${how})` : ', directly connected'}.${also ? ` (${also} also matched, but ${prefix} is more specific.)` : ''}`,
            why: 'Routers pick the most specific (longest-prefix) route that matches the destination IP.',
            concept: 'lpm',
            weight: 'key',
            tone: 'info',
          };
        }
        case 'ttl': {
          const [, a, b] = m(/TTL (\d+) → (\d+)/, t);
          return { say: `TTL ${a} → ${b}. One hop used up; I recompute the header checksum too.`, why: 'Every router decrements TTL so packets cannot loop forever.', concept: 'ttl', weight: 'key', tone: 'info' };
        }
        case 'nexthop': {
          if (/broadcasting ARP request/.test(t)) {
            const [, who] = m(/who has (\S+)\?/, t);
            const [, attempt] = m(/attempt (\d)/, t);
            return {
              say: `Shouting to the whole LAN: "Who has ${who}? Tell me!"${attempt && attempt !== '1' ? ` (try ${attempt})` : ''}`,
              why: 'ARP requests are broadcasts because I don\'t know who to ask yet.',
              concept: 'arp',
              weight: 'key',
              tone: 'warn',
            };
          }
          if (/is on-link/.test(t)) {
            const [, dst, net] = m(/: (\S+) is on-link \(([^)]+)\)/, t);
            return { say: `${ipLabel(ctx, dst)} is in my own subnet (${net}), so I deliver it directly, no router needed.`, concept: 'subnet', weight: 'key', tone: 'info' };
          }
          if (/default gateway/.test(t)) {
            const [, dst, net, gw] = m(/: (\S+) is outside (\S+), sending via default gateway (\S+)/, t);
            return {
              say: `${ipLabel(ctx, dst)} is NOT in my subnet ${net}. I'll hand it to my default gateway ${ipLabel(ctx, gw)}.`,
              why: 'Hosts only know their own subnet; everything else goes to the gateway router.',
              concept: 'gateway',
              weight: 'key',
              tone: 'info',
            };
          }
          if (/directly connected/.test(t)) {
            const [, dst, iface] = m(/(\S+) is directly connected on (\S+)/, t);
            return { say: `${ipLabel(ctx, dst)} is on a network plugged into my ${iface}. Last hop!`, concept: 'routing-table', weight: 'key', tone: 'good' };
          }
          if (/next hop for/.test(t)) {
            const [, , nh, iface] = m(/next hop for (\S+) is (\S+) out (\S+)/, t);
            return { say: `Passing it to the next router, ${ipLabel(ctx, nh)}, via ${iface}.`, concept: 'routing-table', weight: 'key', tone: 'info' };
          }
          return { say: t, weight: 'minor', tone: 'info' };
        }
        case 'reply': {
          if (/replying to ARP/.test(t))
            return {
              say: "That's me! Replying straight to the asker with my MAC address.",
              why: 'ARP replies are unicast: only the asker needs the answer.',
              concept: 'arp',
              weight: 'key',
              tone: 'good',
            };
          const [, from] = m(/from (\S+)/, t);
          return { say: `Ping from ${ipLabel(ctx, from)}! Sending an echo reply back.`, concept: 'ping', weight: 'key', tone: 'good' };
        }
        case 'queue': {
          if (/resolved/.test(t)) {
            const [, n] = m(/sending (\d+) queued/, t);
            return { say: `Got the MAC! Releasing the ${n === '1' ? 'packet' : `${n} packets`} I was holding.`, concept: 'arp', weight: 'key', tone: 'good' };
          }
          return { say: 'Still waiting for the ARP answer, so this packet joins the queue.', concept: 'arp', weight: 'minor', tone: 'warn' };
        }
        case 'icmp-error': {
          if (/not sending ICMP error about an ICMP error/.test(t))
            return { say: "That was already an error message. I won't send an error about an error.", why: 'Prevents error storms (RFC 1812).', concept: 'icmp', weight: 'key', tone: 'muted' };
          if (/Host Unreachable/.test(t))
            return { say: 'Nobody on that LAN owns the address. Telling the sender "Host Unreachable".', concept: 'unreachable', weight: 'key', tone: 'bad' };
          return { say: `Reporting the problem back to the sender with ICMP.`, concept: 'icmp', weight: 'key', tone: 'bad' };
        }
        case 'local':
          return { say: t.replace(/^\S+ /, ''), weight: 'minor', tone: 'muted' };
        case 'fragment': {
          const size = m(/(\d+)-byte/, t)[1];
          const iface = m(/fit (\S+)'s/, t)[1];
          const mtu = m(/MTU (\d+)/, t)[1];
          const n = m(/into (\d+) fragments/, t)[1];
          const offs = m(/offsets ([\d, ]+), sizes/, t)[1];
          const sizes = m(/sizes ([\d, ]+) bytes/, t)[1];
          return {
            say: `This ${size}-byte packet is too big for ${iface} (MTU ${mtu}). Cutting it into ${n} fragments: offsets ${offs} (in 8-byte units), sizes ${sizes} bytes.`,
            why: 'Every fragment gets its own copy of the IP header; MF = 1 on all but the last.',
            concept: 'fragmentation',
            weight: 'key',
            tone: 'warn',
          };
        }
        case 'reassemble': {
          if (/reassembled/.test(t)) {
            const [, n, size] = m(/reassembled (\d+) fragments into the original (\d+)-byte/, t);
            return { say: `All ${n} pieces are here! Rebuilt the original ${size}-byte packet.`, concept: 'reassembly', weight: 'key', tone: 'good' };
          }
          const [, range] = m(/fragment \(bytes ([^)]+)\)/, t);
          return { say: `Got a fragment (bytes ${range}). Holding it until the rest arrive.`, why: 'Only the final destination reassembles; routers just pass fragments along.', concept: 'reassembly', weight: 'key', tone: 'info' };
        }
      }
      return { say: t, weight: 'minor', tone: 'info' };
    }

    case 'drop': {
      switch (e.reason) {
        case 'not-for-me': {
          if (/ARP/.test(t)) {
            const [, ip] = m(/for (\S+) \(/, t);
            return { say: `Someone's asking for ${ip}. That's not me, so I ignore it.`, concept: 'broadcast', weight: 'key', tone: 'muted' };
          }
          const frame = ctx.packet(e.packetId)?.frame.eth;
          return {
            say: `This frame is for ${macLabel(ctx, frame?.dst)}, not me. My network card throws it away.`,
            why: 'This is what flooding costs: bystanders receive copies and discard them.',
            concept: 'nic',
            weight: 'key',
            tone: 'muted',
          };
        }
        case 'ttl-expired': {
          const [, src] = m(/Time Exceeded to (\S+)/, t);
          return {
            say: `TTL ran out here, so this packet dies. I'm telling ${ipLabel(ctx, src)}: "Time Exceeded", from my own address.`,
            why: 'That reply reveals this router\'s address: it\'s how traceroute maps the path.',
            concept: 'ttl',
            weight: 'key',
            tone: 'bad',
          };
        }
        case 'no-route': {
          const [, dst] = m(/no route to (\S+)/, t);
          return {
            say: dst ? `No route to ${dst}: nothing in my routing table matches, not even a default route. Dropping it.` : t.replace(/^\S+ /, ''),
            why: 'A router can only forward to networks it has a route for.',
            concept: 'routing-table',
            weight: 'key',
            tone: 'bad',
          };
        }
        case 'no-gateway':
          return { say: "That address isn't in my subnet and I have no default gateway. I can't send it anywhere.", concept: 'gateway', weight: 'key', tone: 'bad' };
        case 'arp-failed':
          return { say: 'ARP failed, so the packets I was holding are dropped.', concept: 'unreachable', weight: 'key', tone: 'bad' };
        case 'filtered':
          return { say: 'The destination is on the same port this came from: no need to send it anywhere.', concept: 'mac-table', weight: 'key', tone: 'muted' };
        case 'broadcast-not-forwarded':
          return { say: 'Broadcasts stop at routers. Not forwarding this one.', why: 'A router is the edge of a broadcast domain.', concept: 'broadcast', weight: 'key', tone: 'muted' };
        case 'queue-full':
          return { say: 'My queue is full, so a packet had to be dropped.', concept: 'port', weight: 'key', tone: 'bad' };
        case 'bad-checksum':
          return { say: 'The header checksum is wrong (corrupted), so I drop it.', concept: 'checksum', weight: 'key', tone: 'bad' };
        case 'no-link':
          return { say: 'That port has no cable plugged in!', concept: 'port', weight: 'key', tone: 'bad' };
        case 'too-big': {
          const size = m(/(\d+)-byte/, t)[1];
          if (/Fragmentation Needed/.test(t)) {
            const mtu = m(/MTU (\d+)/, t)[1];
            return {
              say: `${size} bytes won't fit the next link (MTU ${mtu}) and DF says "don't fragment". Dropping it and replying "Fragmentation Needed, use ${mtu}".`,
              why: 'That ICMP reply is what Path MTU Discovery listens for.',
              concept: 'df',
              weight: 'key',
              tone: 'bad',
            };
          }
          const lim = m(/is (\d+)$/, t)[1];
          return { say: `I already know the path can't carry ${size} bytes (MTU ${lim}), and DF is set. Not even sending it.`, concept: 'pmtud', weight: 'key', tone: 'bad' };
        }
        case 'reassembly-timeout':
          return { say: 'Some fragments never arrived. After 30 s I throw the pieces away. One lost fragment = the whole packet is lost.', concept: 'reassembly', weight: 'key', tone: 'bad' };
        case 'link-loss':
          return { say: 'A frame was lost on the cable before it reached me.', concept: 'packet-loss', weight: 'key', tone: 'bad' };
        default:
          return { say: t.replace(/^\S+ /, ''), weight: 'minor', tone: 'muted' };
      }
    }

    case 'app': {
      const body = t.replace(/^\S+ /, '');
      if (e.app === 'pmtud') {
        if (e.status === 'done') return { say: `Result: ${body}.`, concept: 'pmtud', weight: 'key', tone: /= \d+/.test(body) ? 'good' : 'warn' };
        if (e.status === 'start') return { say: 'Path MTU discovery: I send big packets with DF set and shrink them whenever a router says "too big".', concept: 'pmtud', weight: 'key', tone: 'info' };
        if (e.status === 'error') return { say: body.replace(/^(\S+) says: too big, next-hop MTU (\d+)/, (_, r, n) => `${ipLabel(ctx, r)} says the next link only takes ${n} bytes. Trying again at ${n}.`), concept: 'df', weight: 'key', tone: 'warn' };
        return { say: body.replace(/^probe/, 'Probing with'), concept: 'pmtud', weight: e.status === 'hop' ? 'key' : 'minor', tone: e.status === 'reply' ? 'good' : 'info' };
      }
      if (e.app === 'mtr') {
        if (e.status === 'start') return { say: `MTR: probing every hop to ${body.split(' ')[2]?.replace(':', '')} several times to measure loss and delay per hop.`, concept: 'mtr', weight: 'key', tone: 'info' };
        if (/round \d+\/\d+ done/.test(body)) return { say: `MTR ${body}.`, concept: 'mtr', weight: 'minor', tone: 'info' };
        if (/^HOST/.test(body)) return { say: 'MTR report (loss %, probes sent, avg / best / worst ms):', concept: 'mtr', weight: 'key', tone: 'info' };
        if (/^\s*\d+\./.test(body)) {
          const [, hop, addr, loss] = m(/^\s*(\d+)\.\s+(\S+)\s+(\S+)%/, body);
          return { say: `Hop ${hop}: ${ipLabel(ctx, addr)} with ${loss}% loss.${Number(loss) > 0 ? ' Some probes got no answer.' : ''}`, concept: 'mtr', weight: 'key', tone: Number(loss) > 0 ? 'warn' : 'good' };
        }
        return { say: body, concept: 'mtr', weight: 'key', tone: e.status === 'error' ? 'bad' : 'good' };
      }
      if (e.status === 'start')
        return e.app === 'ping'
          ? { say: `Let's ping ${body.split(' ')[1]?.replace(':', '')}: is it reachable, and how fast?`, concept: 'ping', weight: 'key', tone: 'info' }
          : { say: `Tracing the route to ${body.split(' ')[2]?.replace(',', '')}: probes with TTL 1, 2, 3…`, concept: 'traceroute', weight: 'key', tone: 'info' };
      if (e.status === 'sent') return { say: body, weight: 'minor', tone: 'info' };
      if (e.status === 'reply') {
        const [, from, ttl, time] = m(/from (\S+): icmp_seq=\d+ ttl=(\d+) time=(\S+ ms)/, body);
        return from
          ? { say: `Reply from ${ipLabel(ctx, from)} in ${time}! (TTL ${ttl} tells me it crossed ${64 - Number(ttl)} router${64 - Number(ttl) === 1 ? '' : 's'}.)`, concept: 'ping', weight: 'key', tone: 'good' }
          : { say: body, weight: 'minor', tone: 'muted' };
      }
      if (e.status === 'timeout') return { say: 'No reply in time: that ping is lost.', concept: 'ping', weight: 'key', tone: 'bad' };
      if (e.status === 'error') {
        const [, from] = m(/^From (\S+)/, body);
        if (/Time to live exceeded/.test(body)) return { say: `${ipLabel(ctx, from)} says my packet's TTL ran out.`, concept: 'ttl', weight: 'key', tone: 'bad' };
        if (/Net Unreachable/.test(body)) return { say: `${ipLabel(ctx, from)} says it has no route to that network.`, concept: 'unreachable', weight: 'key', tone: 'bad' };
        if (/Host Unreachable/.test(body)) return { say: `Destination host unreachable, reported by ${ipLabel(ctx, from)}.`, concept: 'unreachable', weight: 'key', tone: 'bad' };
        if (/Frag needed/.test(body)) {
          const [, mtu] = m(/mtu = (\d+)/, body);
          return { say: `${ipLabel(ctx, from)} says my packet is too big for the path (MTU ${mtu}) and I asked it not to fragment.`, concept: 'pmtud', weight: 'key', tone: 'bad' };
        }
        if (/Message too long/.test(body)) {
          const [, mtu] = m(/mtu = (\d+)/, body);
          return { say: `Message too long: I already know the path MTU is ${mtu}, so this DF packet can't go.`, concept: 'pmtud', weight: 'key', tone: 'bad' };
        }
        if (/reassembly time exceeded/.test(body)) return { say: `${ipLabel(ctx, from)} gave up waiting for some of my fragments.`, concept: 'reassembly', weight: 'key', tone: 'bad' };
        return { say: body, concept: 'icmp', weight: 'key', tone: 'bad' };
      }
      if (e.status === 'hop') {
        const parts = body.trim().split(/\s+/);
        const hop = parts[0];
        const addr = parts[1];
        return addr === '*'
          ? { say: `Hop ${hop}: no answer (*).`, concept: 'traceroute', weight: 'key', tone: 'warn' }
          : { say: `Hop ${hop} is ${ipLabel(ctx, addr)}.`, concept: 'traceroute', weight: 'key', tone: 'good' };
      }
      return { say: body.replace(/^--- /, ''), concept: e.app === 'ping' ? 'ping' : 'traceroute', weight: 'key', tone: /0% packet loss|complete/.test(body) && !/100%/.test(body) ? 'good' : 'warn' };
    }
  }
}

export interface PacketStory {
  title: string;
  say: string;
  concept: ConceptId;
}

/** What this packet is and why it exists, for hover cards. */
export function explainPacket(tx: TxEvent, ctx: ExplainCtx): PacketStory {
  const eth = tx.frame.eth;
  const p = eth.payload;
  const from = ctx.name(tx.node);
  const to = ctx.name(tx.toNode);
  const hop = `On the cable ${from} → ${to}.`;
  if (p.kind === 'arp') {
    if (p.oper === 1)
      return { title: 'ARP request (broadcast)', say: `${ipLabel(ctx, p.spa)} asks everyone: "Who has ${p.tpa}?" It knows the IP but needs the MAC. ${hop}`, concept: 'arp' };
    return { title: 'ARP reply', say: `${ipLabel(ctx, p.spa)} answers "${p.spa} is at ${p.sha}", sent only to the asker. ${hop}`, concept: 'arp' };
  }
  if (p.kind === 'ipv4' && (p.flags & 1 || p.fragmentOffset > 0)) {
    const from = p.fragmentOffset * 8;
    const len = p.totalLength - p.ihl * 4;
    return {
      title: `IP fragment · offset ${p.fragmentOffset}${p.flags & 1 ? ' · MF' : ' · last'}`,
      say: `A slice of a bigger packet (id ${p.identification}) from ${ipLabel(ctx, p.src)}: bytes ${from}–${from + len - 1}. ${p.flags & 1 ? 'More fragments follow.' : 'This is the last piece.'} Only ${ipLabel(ctx, p.dst)} will put it back together. ${hop}`,
      concept: 'fragmentation',
    };
  }
  if (p.kind === 'ipv4' && p.payload.kind === 'icmp') {
    const q = p.payload;
    const macNote = `Ethernet is addressed to ${macLabel(ctx, eth.dst)} for this hop; the IP addresses stay ${p.src} → ${p.dst} end to end.`;
    if (q.type === 8) return { title: `Ping request · TTL ${p.ttl}`, say: `${ipLabel(ctx, p.src)} → ${ipLabel(ctx, p.dst)}: "are you there?" ${macNote}`, concept: 'ping' };
    if (q.type === 0) return { title: `Ping reply · TTL ${p.ttl}`, say: `${ipLabel(ctx, p.src)} answers ${ipLabel(ctx, p.dst)}: "yes, I'm here!" ${macNote}`, concept: 'ping' };
    if (q.type === 11) return { title: 'ICMP Time Exceeded', say: `${ipLabel(ctx, p.src)} reports to ${ipLabel(ctx, p.dst)} that a packet's TTL ran out. ${hop}`, concept: 'ttl' };
    if (q.type === 3 && q.code === 4)
      return { title: 'ICMP Fragmentation Needed', say: `${ipLabel(ctx, p.src)} tells ${ipLabel(ctx, p.dst)}: "your packet was too big and had DF set; use at most ${'unused' in q ? q.unused & 0xffff : '?'} bytes". ${hop}`, concept: 'pmtud' };
    if (q.type === 3) return { title: 'ICMP Destination Unreachable', say: `${ipLabel(ctx, p.src)} tells ${ipLabel(ctx, p.dst)} it couldn't deliver a packet. ${hop}`, concept: 'unreachable' };
  }
  return { title: 'Frame', say: hop, concept: 'ethernet' };
}

/** Destination MAC of a frame is a group (broadcast/multicast) address. */
export function isBroadcastFrame(tx: TxEvent): boolean {
  return isGroupMac(tx.frame.eth.dst);
}
