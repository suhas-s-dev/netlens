# NetLens

An interactive 3D network simulator that runs in the browser. Build a topology of hosts, switches and routers, send pings and traceroutes, and watch every frame move across the wires. Zoom in to see a device's live tables, or click a packet to inspect its headers and real bytes.

The simulation is genuine. ARP, MAC learning, flooding, longest-prefix match, TTL expiry and ICMP errors all come from a deterministic discrete-event engine, not from scripted animation.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # engine tests (Vitest, Node)
npm run typecheck
npm run build      # type-check + production bundle into dist/
npm run deploy     # build + wrangler deploy (needs `wrangler login` first)
```

## Learning features

- **Narration:** devices explain each decision in speech bubbles, in their own voice ("I've never seen H3's MAC, so I'm flooding out ports 2, 3"). The `?` chips open the matching glossary entry.
- **Guided lessons:** one per preset (top bar **▶ Lesson**). The sim plays until the exact engine event a step is about, pauses, flies to the device, explains it, and sometimes asks a quick multiple-choice question.
- **Concept cards** in every device, link and packet panel, plus a **What it just did** feed per device with the *why* behind each action.
- **Packet hover cards** say what a moving packet is and why it exists. The inspector explains every layer and header field.
- **Glossary** of 28 networking concepts with analogies and cross-links. The event log has a **plain English** mode.
- All explanations come from `src/learn/`, which rephrases real engine events. Tests check that every event in every preset has a clean explanation and that every lesson trigger fires in order.

## Visual style

Pixel-art 3D: three.js's `RenderPixelatedPass` (no extra dependency) renders the scene at 1/3 resolution with edge highlights. Voxel devices have LEDs and screens that light up with real traffic. Each LAN (broadcast domain) sits on its own floating tiled island, and drops and replies show as voxel particle bursts. Turn off **Pixel** in the top bar for smooth rendering.

## Using it

- **Presets** (top bar): *Single LAN*, *Two LANs + router*, *Three-router chain*, *MTU bottleneck*, *TCP & UDP*. Each preset has a short scripted scenario that starts when you press Play.
- **Tools** (left panel): Ping (count, data size, Don't Fragment), Traceroute, MTR (rounds of per-hop loss/latency), PMTUD (tracepath-style path-MTU discovery), TCP (connect to any port and download N bytes; every host runs a web server on port 80) and UDP (datagrams to any port; every host runs an echo service on port 7).
- **Time:** `Space` plays or pauses. `.` or `→` steps to the next event. The slider sets speed from 0.1x to 4x. At 1x, 5 ms of sim time passes per wall-clock second, so a 2 ms hop takes about 0.4 s on screen. When nothing is on the wire, time runs faster (1 s of sim time per second), and short idle gaps are skipped.
- **Detail by distance:** zoomed out shows device names and IPs. Closer in, port indicators and link flashes appear. Closest, port labels and gateways appear. Click a device to see its live tables (ARP, MAC, routes). Rows flash when added, used or refreshed, and turn red when they age out. Double-click a device to fly to it.
- **Packets:** colour shows the protocol: amber ARP, blue echo request, green echo reply, red ICMP error. Streak length is the frame's serialization time. Clicking a packet pauses the sim and opens the inspector: collapsible layers, a hex dump, field ↔ byte hover highlighting, and the packet's flow hop by hop.
- **Event log:** shows every engine decision in plain English. You can filter by device or event type. Clicking an entry focuses its device or opens its packet.
- **3D / Iso:** switches between free perspective and an orthographic 2.5D view.
- **Edit mode:** add devices from the palette and drag them around. To link two devices, click a grey port on one, then a port on another. Edit IPs, gateways, interfaces, static routes and link latency/bandwidth in the side panel. Validation runs live (overlapping subnets, gateway outside its subnet, duplicate IPs/MACs, unreachable next hops, and more). Press **Simulate this network** to run it.
- **Save / Load:** saves named topologies to localStorage, and exports or imports JSON (`*.netlens.json`).

## Architecture

```
src/
  learn/             concepts (glossary), explain (event → learner text), lessons, field notes
  engine/            pure TypeScript simulator; no React, three.js or DOM
    core/            EventQueue (time, seq heap), Rng (mulberry32), Engine, time units
    model/           topology JSON types, Frame
    protocols/       Ethernet II, ARP, IPv4, ICMP: encode/decode + field byte spans
    devices/         Host (ping/traceroute), Switch, Router, shared ArpResolver, LPM
    topology/        build runtime devices from JSON, validation
    trace/           structured trace event types
    __tests__/       Vitest suites + preset trace snapshots
  state/             zustand store + SimController (engine ↔ UI bridge), edit ops, storage
  render/            r3f scene: devices, link tubes, instanced packets, labels, camera/LOD, editor layer
  ui/                panels, inspector, event log, time controls, editor forms
  presets/           scenario JSON files
worker/              Cloudflare Worker entry (static assets; /api/* reserved)
```

- **Deterministic:** events are ordered by `(time, insertion seq)` and all randomness comes from a seeded RNG. The same topology and the same commands produce the same trace. The snapshot tests enforce this for every preset.
- **One-way data flow:** the UI never mutates the engine. User actions go through commands (`engine.ping`, `engine.traceroute`) and the clock (`step`, `runUntil`). Each decision emits a `TraceEvent` with a `text` explanation. These events feed the event log, the renderer (`tx` events carry exact `txStart` / `txEnd` / `arrive` times) and the tests.
- **Rendering cost:** the renderer reads the set of in-flight frames directly each animation frame, without React. All packets are drawn as two instanced meshes, so the draw-call count stays flat. Store updates for the log and tables are throttled to about 15 Hz while playing. Measured in dev: about 0.3 ms average CPU per frame with 1,200+ frames in flight.
- **Real bytes:** every frame encodes to real bytes, with correct field order, Ethernet padding to 60 bytes, and IPv4 and ICMP checksums per RFC 1071. The encoder records a byte range for every header field, which drives the hex-view highlighting. Tests check the checksums against RFC 1071, the classic `0xb861` IPv4 header and the Windows ping `0x4d5a` vectors.

### Behaviour notes (RFC references are in code comments)

- **MTU and fragmentation (RFC 791, 1191):**
  - Each interface has an MTU (default 1500; the RFC 791 minimum is 68).
  - Hosts and routers fragment oversized packets into 8-byte-aligned slices, keeping the same Identification and setting MF/offset. Fragments of fragments keep offsets relative to the original.
  - Only the destination reassembles, with a 30 s timeout that sends ICMP Time Exceeded code 1.
  - When DF is set, a router drops the packet and replies "Fragmentation Needed" with the next-hop MTU. Hosts cache the path MTU for 10 minutes.
- **UDP (RFC 768):** pseudo-header checksum, echo service on port 7, ICMP Port Unreachable for closed ports. Large datagrams are fragmented by IP.
- **TCP (RFC 9293):**
  - The full state machine: handshake, MSS option, FIN teardown with TIME_WAIT (MSL shortened to 2 s so you can watch it), RST for closed ports.
  - Data is segmented by MSS, and the peer's window limits how much can be in flight. ACKs are cumulative and piggybacked on data.
  - Lost data is resent on a retransmission timer (RTT-based RTO per RFC 6298, 200 ms minimum, doubling on each timeout, Karn's rule) or after 3 duplicate ACKs (fast retransmit, RFC 5681).
  - Every segment has DF set, so ICMP Fragmentation Needed lowers the MSS (PMTUD).
  - Simplified: no congestion window, no delayed ACKs, out-of-order segments are dropped (answered with a duplicate ACK), go-back-N retransmission.
- **Link loss:** a per-link loss percentage drawn from the seeded RNG, so lossy runs are reproducible.

- **Timing:** serialization delay counts preamble, SFD, FCS and the inter-frame gap. Links are full duplex. Each port has a FIFO transmit queue (64 frames, tail drop).
- **ARP:** the RFC 826 merge algorithm. Up to 3 packets per destination are queued while resolution is pending, oldest dropped first. Requests are retried 3 times, 1 s apart, then the queued packets are dropped. A host reports *Destination Host Unreachable*; a router sends ICMP Host Unreachable. Entries time out after 60 s.
- **Switch:** 802.1D learning with 300 s aging. Broadcast, multicast and unknown unicast are flooded out every linked port except the ingress port. Frames whose destination is on the ingress port are filtered. There is no STP, so a physical loop will storm.
- **Router:**
  - Connected routes are added automatically; static routes are resolved to a connected next hop (no recursive lookup).
  - Longest-prefix match, with ties broken by admin distance (connected beats static).
  - The route lookup happens before the TTL check, as in Linux.
  - TTL is decremented and the header checksum fully recomputed.
  - ICMP errors are sourced from the egress interface (RFC 1812 4.3.2.4), and never sent about ICMP errors or broadcasts.
  - Broadcasts are not forwarded.
- **Traceroute:** uses ICMP echo probes (Windows `tracert` style) until UDP arrives in Phase 2. It sends 3 probes per hop, one at a time.

## Deployment (Cloudflare Workers)

`wrangler.jsonc` serves `dist/` as static assets with SPA fallback (`not_found_handling: single-page-application`). The Worker script runs only for `/api/*` (`run_worker_first`); today that is just `/api/health`. To add shared sessions later, add a Durable Object binding and route `/api/session/:id` to it from `worker/index.ts`; the commented config is already in `wrangler.jsonc`. The engine has no DOM dependencies, so the same code can run inside a Durable Object.

## Roadmap

- **Phase 2:** UDP, TCP (state machine, handshake, retransmission), DNS, DHCP, NAT, ACLs and a stateful firewall, VLANs.
- **Phase 3:** security scenarios: SYN flood with a backlog meter, reflection/amplification, scrubbing-centre diversion, mitigation toggles.
- **Phase 4:** shared live sessions (Durable Objects + WebSockets), pcap import and replay, "explain this packet".
