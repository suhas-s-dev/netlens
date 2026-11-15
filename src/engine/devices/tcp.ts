/**
 * A compact TCP (RFC 9293) for hosts.
 *
 * Implemented: the full connection state machine (3-way handshake, data transfer, FIN
 * teardown incl. simultaneous close states, TIME_WAIT), RST for closed ports, MSS option,
 * segmentation by MSS, the peer's advertised window as the send limit, cumulative ACKs,
 * retransmission timeout with RFC 6298 RTT estimation and exponential backoff (Karn's rule),
 * fast retransmit after 3 duplicate ACKs (RFC 5681), and MSS reduction on ICMP
 * "Fragmentation Needed" (TCP sends with DF set: RFC 1191 PMTUD).
 *
 * Simplified (noted where relevant): no congestion window (slow start / cwnd: later),
 * no delayed ACKs (every segment is ACKed at once), out-of-order segments are discarded
 * and answered with a duplicate ACK instead of being buffered, retransmission is go-back-N,
 * MSL is shortened to 2 s so TIME_WAIT (2×MSL) is watchable.
 */
import type { ScheduledEvent } from '../core/EventQueue';
import { MS, SEC } from '../core/time';
import type { Ipv4 } from '../protocols/addr';
import { makeIpv4 } from '../protocols/ipv4';
import { makeTcp, tcpChecksumValid, tcpFlagNames } from '../protocols/tcp';
import { IPPROTO_TCP, IPV4_FLAG_DF, TCP_ACK, TCP_FIN, TCP_PSH, TCP_RST, TCP_SYN, TCPOPT_MSS, type Ipv4Packet, type TcpSegment } from '../protocols/types';
import type { Frame } from '../model/frame';
import type { Host } from './Host';

export type TcpState = 'CLOSED' | 'LISTEN' | 'SYN_SENT' | 'SYN_RCVD' | 'ESTABLISHED' | 'FIN_WAIT_1' | 'FIN_WAIT_2' | 'CLOSE_WAIT' | 'CLOSING' | 'LAST_ACK' | 'TIME_WAIT';

/** RFC 9293 3.7.1: assume 536 if the peer sends no MSS option. */
const DEFAULT_PEER_MSS = 536;
const RCV_WINDOW = 65535;
const MSL = 2 * SEC; // shortened (RFC suggests 2 minutes) so TIME_WAIT is visible
const INITIAL_RTO = 1 * SEC; // RFC 6298 2.1
const MIN_RTO = 200 * MS; // Linux's floor (RFC 6298 says 1 s)
const MAX_RTO = 60 * SEC;
const SYN_RETRIES = 3;
const DATA_RETRIES = 6;

const add = (a: number, b: number) => (a + b) >>> 0;
const diff = (a: number, b: number) => (a - b) | 0;
const lt = (a: number, b: number) => diff(a, b) < 0;
const le = (a: number, b: number) => diff(a, b) <= 0;

export interface TcpCallbacks {
  onEstablished?(c: TcpConnection): void;
  onData?(c: TcpConnection, data: Uint8Array): void;
  /** Peer sent FIN: it has nothing more to send. */
  onPeerClose?(c: TcpConnection): void;
  /** Connection fully closed (reason given on errors). */
  onClosed?(c: TcpConnection, reason: string | null): void;
}

export class TcpConnection {
  state: TcpState = 'CLOSED';
  readonly id: string;
  iss: number;
  irs = 0;
  sndUna: number;
  sndNxt: number;
  sndWnd = DEFAULT_PEER_MSS;
  rcvNxt = 0;
  /** Last ack number we advertised (any segment with ACK set). */
  lastAckSent = -1;
  /** Effective send MSS (peer's MSS, lowered by path MTU). */
  mss = DEFAULT_PEER_MSS;
  readonly myMss: number;
  /** All bytes the application has written; sendBuf[0] has sequence number iss + 1. */
  private sendBuf = new Uint8Array(0);
  finPending = false;
  finSeq: number | null = null;
  rto = INITIAL_RTO;
  srtt: number | null = null;
  rttvar = 0;
  retries = 0;
  dupAcks = 0;
  rtoTimer: ScheduledEvent | null = null;
  private rttProbe: { end: number; at: number } | null = null;
  private retransmitted = false;
  bytesSent = 0;
  bytesReceived = 0;
  segmentsReceived = 0;
  retransmissions = 0;
  openedAt: number;
  establishedAt: number | null = null;
  cb: TcpCallbacks = {};

  constructor(
    readonly stack: TcpStack,
    readonly localIp: Ipv4,
    readonly localPort: number,
    readonly remoteIp: Ipv4,
    readonly remotePort: number,
    readonly role: 'client' | 'server',
  ) {
    this.id = `${localIp}:${localPort}-${remoteIp}:${remotePort}`;
    this.iss = stack.host.engine.rng.nextU32();
    this.sndUna = this.iss;
    this.sndNxt = this.iss;
    this.myMss = (stack.host.nic?.mtu ?? 1500) - 40;
    this.openedAt = stack.host.engine.now;
  }

  /** Sequence numbers relative to the ISNs, like Wireshark shows them. */
  relSnd(seq: number): number {
    return diff(seq, this.iss);
  }
  relRcv(seq: number): number {
    return diff(seq, this.irs);
  }

  get bufEnd(): number {
    return add(add(this.iss, 1), this.sendBuf.length);
  }

  write(data: Uint8Array): void {
    const n = new Uint8Array(this.sendBuf.length + data.length);
    n.set(this.sendBuf);
    n.set(data, this.sendBuf.length);
    this.sendBuf = n;
    this.stack.pump(this);
  }

  /** Application is done sending: FIN goes out after the queued data. */
  close(): void {
    if (this.finPending) return;
    this.finPending = true;
    this.stack.pump(this);
  }

  slice(seq: number, len: number): Uint8Array {
    const off = diff(seq, add(this.iss, 1));
    return this.sendBuf.subarray(off, off + len);
  }

  startProbe(end: number): void {
    if (!this.rttProbe && !this.retransmitted) this.rttProbe = { end, at: this.stack.host.engine.now };
  }

  /** RFC 6298 RTT estimation on a new cumulative ACK. */
  sample(ack: number): void {
    const p = this.rttProbe;
    if (!p || lt(ack, p.end)) return;
    this.rttProbe = null;
    if (this.retransmitted) return; // Karn's algorithm: ignore samples from retransmissions
    const r = this.stack.host.engine.now - p.at;
    if (this.srtt === null) {
      this.srtt = r;
      this.rttvar = r / 2;
    } else {
      this.rttvar = 0.75 * this.rttvar + 0.25 * Math.abs(this.srtt - r);
      this.srtt = 0.875 * this.srtt + 0.125 * r;
    }
    this.rto = Math.min(MAX_RTO, Math.max(MIN_RTO, Math.round(this.srtt + 4 * this.rttvar)));
  }

  markRetransmit(): void {
    this.retransmitted = true;
    this.rttProbe = null;
    this.retransmissions++;
  }

  clearRetransmitFlag(): void {
    this.retransmitted = false;
  }
}

export class TcpStack {
  readonly conns = new Map<string, TcpConnection>();
  private listeners = new Map<number, (c: TcpConnection) => TcpCallbacks>();
  /** Ephemeral port counter; drawn from the RNG on first use so topologies without TCP keep
   * identical traces. */
  private nextPort = 0;

  constructor(readonly host: Host) {}

  private get name(): string {
    return this.host.name;
  }

  listen(port: number, accept: (c: TcpConnection) => TcpCallbacks): void {
    this.listeners.set(port, accept);
  }

  listening(): number[] {
    return [...this.listeners.keys()];
  }

  connect(dst: Ipv4, port: number, cb: TcpCallbacks): TcpConnection | string {
    const src = this.host.ip;
    if (!src) return 'No IP address configured';
    if (!this.nextPort) this.nextPort = 49152 + this.host.engine.rng.int(0, 999);
    const c = new TcpConnection(this, src, this.nextPort++, dst, port, 'client');
    c.cb = cb;
    this.conns.set(c.id, c);
    this.setState(c, 'SYN_SENT', `${this.name} opens a connection to ${dst}:${port} from port ${c.localPort}`);
    this.sendSyn(c);
    return c;
  }

  // ------------------------------------------------------------------ output

  private emitSeg(c: TcpConnection, flags: number, seq: number, data?: Uint8Array, opts: { mss?: number } = {}): void {
    const o: Parameters<typeof makeTcp>[2] = { srcPort: c.localPort, dstPort: c.remotePort, seq, ack: flags & TCP_ACK ? c.rcvNxt : 0, flags, window: RCV_WINDOW };
    if (data) o.data = data;
    if (opts.mss !== undefined) o.mss = opts.mss;
    const seg = makeTcp(c.localIp, c.remoteIp, o);
    if (flags & TCP_ACK) c.lastAckSent = c.rcvNxt;
    // TCP always sets DF so routers report a smaller path MTU instead of fragmenting.
    const pkt = makeIpv4({ src: c.localIp, dst: c.remoteIp, protocol: IPPROTO_TCP, identification: this.host.nextIpId(), flags: IPV4_FLAG_DF, payload: seg });
    const err = this.host.sendIp(pkt, { flowId: this.host.engine.newFlowId() });
    if (err) {
      const m = /mtu = (\d+)/.exec(err);
      if (m) this.lowerMss(c, Number(m[1]) - 40, 'my cached path MTU');
    }
  }

  private sendSyn(c: TcpConnection): void {
    c.sndNxt = add(c.iss, 1);
    this.host.decision('tcp', `${this.name} sends SYN to ${c.remoteIp}:${c.remotePort}: seq=0 (ISN ${c.iss}), MSS ${c.myMss}`);
    c.startProbe(c.sndNxt);
    this.emitSeg(c, TCP_SYN, c.iss, undefined, { mss: c.myMss });
    this.armRto(c);
  }

  private sendSynAck(c: TcpConnection): void {
    c.sndNxt = add(c.iss, 1);
    this.host.decision('tcp', `${this.name} sends SYN-ACK to ${c.remoteIp}:${c.remotePort}: seq=0 (ISN ${c.iss}), ack=1, MSS ${c.myMss}`);
    c.startProbe(c.sndNxt);
    this.emitSeg(c, TCP_SYN | TCP_ACK, c.iss, undefined, { mss: c.myMss });
    this.armRto(c);
  }

  sendAck(c: TcpConnection, why: string): void {
    this.host.decision('tcp', `${this.name} sends ACK ack=${c.relRcv(c.rcvNxt)} (${why})`);
    this.emitSeg(c, TCP_ACK, c.sndNxt);
  }

  /** Send as much queued data (then FIN) as the peer's window allows. */
  pump(c: TcpConnection): void {
    if (c.state !== 'ESTABLISHED' && c.state !== 'CLOSE_WAIT' && c.state !== 'FIN_WAIT_1' && c.state !== 'LAST_ACK' && c.state !== 'CLOSING') return;
    const mss = Math.min(c.mss, this.host.pathMtu(c.remoteIp) - 40);
    const end = c.bufEnd;
    let sent = 0;
    while (lt(c.sndNxt, end)) {
      const inflight = diff(c.sndNxt, c.sndUna);
      const room = c.sndWnd - inflight;
      if (room <= 0) {
        this.host.decision('tcp', `${this.name} waits: ${inflight} bytes unacknowledged fill the peer's window of ${c.sndWnd}`);
        break;
      }
      const len = Math.min(mss, diff(end, c.sndNxt), room);
      const data = c.slice(c.sndNxt, len);
      const last = add(c.sndNxt, len) === end;
      this.host.decision(
        'tcp',
        `${this.name} sends ${len} bytes to ${c.remoteIp}:${c.remotePort}: seq=${c.relSnd(c.sndNxt)} (bytes ${c.relSnd(c.sndNxt)}–${c.relSnd(c.sndNxt) + len - 1}), MSS ${mss}`,
      );
      c.startProbe(add(c.sndNxt, len));
      this.emitSeg(c, TCP_ACK | (last ? TCP_PSH : 0), c.sndNxt, data);
      c.sndNxt = add(c.sndNxt, len);
      c.bytesSent = Math.max(c.bytesSent, diff(c.sndNxt, add(c.iss, 1)));
      sent++;
      if (!c.rtoTimer) this.armRto(c);
    }
    if (c.finPending && c.finSeq === null && c.sndNxt === end) {
      c.finSeq = c.sndNxt;
      this.host.decision('tcp', `${this.name} sends FIN to ${c.remoteIp}:${c.remotePort}: seq=${c.relSnd(c.sndNxt)}, nothing more to send`);
      this.emitSeg(c, TCP_FIN | TCP_ACK, c.sndNxt);
      c.sndNxt = add(c.sndNxt, 1);
      if (c.state === 'ESTABLISHED') this.setState(c, 'FIN_WAIT_1', `${this.name} has sent everything and closes its side`);
      else if (c.state === 'CLOSE_WAIT') this.setState(c, 'LAST_ACK', `${this.name} closes its side too`);
      if (!c.rtoTimer) this.armRto(c);
    }
    void sent;
  }

  private armRto(c: TcpConnection): void {
    if (c.rtoTimer) c.rtoTimer.cancelled = true;
    c.rtoTimer = this.host.engine.schedule(c.rto, `${this.name} TCP RTO ${c.id}`, () => this.onRto(c), this.host.id);
  }

  private stopRto(c: TcpConnection): void {
    if (c.rtoTimer) c.rtoTimer.cancelled = true;
    c.rtoTimer = null;
  }

  private onRto(c: TcpConnection): void {
    c.rtoTimer = null;
    if (c.state === 'CLOSED' || c.state === 'TIME_WAIT') return;
    if (c.sndUna === c.sndNxt) return;
    c.retries++;
    const limit = c.state === 'SYN_SENT' || c.state === 'SYN_RCVD' ? SYN_RETRIES : DATA_RETRIES;
    if (c.retries > limit) {
      this.abort(c, c.state === 'SYN_SENT' ? 'Connection timed out (no answer to SYN)' : 'Connection timed out (no ACKs)');
      return;
    }
    const old = c.rto;
    c.rto = Math.min(MAX_RTO, c.rto * 2); // exponential backoff
    c.markRetransmit();
    this.host.decision('tcp', `${this.name} retransmission timeout after ${Math.round(old / MS)} ms: no ACK for seq=${c.relSnd(c.sndUna)}. Resending (try ${c.retries}), next timeout ${Math.round(c.rto / MS)} ms`);
    if (c.state === 'SYN_SENT') return this.sendSyn(c);
    if (c.state === 'SYN_RCVD') return this.sendSynAck(c);
    // Go-back-N: resend everything from the oldest unacknowledged byte.
    if (c.finSeq !== null && le(c.sndUna, c.finSeq)) c.finSeq = null;
    c.sndNxt = c.sndUna;
    this.armRto(c);
    this.pump(c);
  }

  // ------------------------------------------------------------------ input

  input(ip: Ipv4Packet, seg: TcpSegment, frame: Frame): void {
    const meta = { packetId: frame.id, flowId: frame.flowId };
    if (!tcpChecksumValid(ip.src, ip.dst, seg)) {
      this.host.drop('bad-checksum', `${this.name} dropped TCP segment from ${ip.src}: bad checksum`, meta);
      return;
    }
    const id = `${ip.dst}:${seg.dstPort}-${ip.src}:${seg.srcPort}`;
    const c = this.conns.get(id);
    if (!c) return this.noConnection(ip, seg, meta);
    this.process(c, seg);
  }

  private noConnection(ip: Ipv4Packet, seg: TcpSegment, meta: { packetId: string; flowId: string }): void {
    const accept = this.listeners.get(seg.dstPort);
    if (accept && seg.flags & TCP_SYN && !(seg.flags & (TCP_ACK | TCP_RST))) {
      const c = new TcpConnection(this, ip.dst, seg.dstPort, ip.src, seg.srcPort, 'server');
      this.conns.set(c.id, c);
      c.irs = seg.seq;
      c.rcvNxt = add(seg.seq, 1);
      c.sndWnd = seg.window;
      c.mss = Math.min(c.myMss, seg.options.find((o) => o.kind === TCPOPT_MSS)?.mss ?? DEFAULT_PEER_MSS);
      c.cb = accept(c);
      this.setState(c, 'SYN_RCVD', `${this.name} port ${seg.dstPort} accepts a SYN from ${ip.src}:${seg.srcPort} (their MSS ${seg.options.find((o) => o.kind === TCPOPT_MSS)?.mss ?? 'none'})`);
      this.sendSynAck(c);
      return;
    }
    if (seg.flags & TCP_RST) return;
    // RFC 9293 3.10.7.1: anything else to a closed port is answered with RST.
    this.host.drop('port-closed', `${this.name}: nothing listens on TCP port ${seg.dstPort}; answering with RST`, meta);
    const len = seg.data.length + (seg.flags & TCP_SYN ? 1 : 0) + (seg.flags & TCP_FIN ? 1 : 0);
    const rst =
      seg.flags & TCP_ACK
        ? makeTcp(ip.dst, ip.src, { srcPort: seg.dstPort, dstPort: seg.srcPort, seq: seg.ack, ack: 0, flags: TCP_RST, window: 0 })
        : makeTcp(ip.dst, ip.src, { srcPort: seg.dstPort, dstPort: seg.srcPort, seq: 0, ack: add(seg.seq, len), flags: TCP_RST | TCP_ACK, window: 0 });
    this.host.decision('tcp', `${this.name} sends RST to ${ip.src}:${seg.srcPort}: port ${seg.dstPort} is closed`, meta);
    this.host.sendIp(makeIpv4({ src: ip.dst, dst: ip.src, protocol: IPPROTO_TCP, identification: this.host.nextIpId(), flags: IPV4_FLAG_DF, payload: rst }), { flowId: this.host.engine.newFlowId(), parentId: meta.packetId });
  }

  private process(c: TcpConnection, seg: TcpSegment): void {
    const flags = tcpFlagNames(seg.flags);
    if (c.state === 'SYN_SENT') {
      if (seg.flags & TCP_ACK && seg.ack !== add(c.iss, 1)) return; // not for our SYN
      if (seg.flags & TCP_RST) {
        if (seg.flags & TCP_ACK) this.abort(c, `Connection refused: ${c.remoteIp} answered RST (port ${c.remotePort} closed)`, false);
        return;
      }
      if (seg.flags & TCP_SYN) {
        c.irs = seg.seq;
        c.rcvNxt = add(seg.seq, 1);
        c.sndWnd = seg.window;
        const peerMss = seg.options.find((o) => o.kind === TCPOPT_MSS)?.mss ?? DEFAULT_PEER_MSS;
        c.mss = Math.min(c.myMss, peerMss);
        if (seg.flags & TCP_ACK) {
          c.sndUna = seg.ack;
          c.sample(seg.ack);
          c.clearRetransmitFlag();
          c.retries = 0;
          this.stopRto(c);
          c.establishedAt = this.host.engine.now;
          this.setState(c, 'ESTABLISHED', `${this.name} got SYN-ACK from ${c.remoteIp}: handshake step 3, connection established (MSS ${c.mss})`);
          this.sendAck(c, 'third step of the handshake');
          c.cb.onEstablished?.(c);
          this.pump(c);
        }
      }
      return;
    }

    // Sequence check: we only take the next expected byte (no out-of-order buffering).
    const segLen = seg.data.length + (seg.flags & TCP_SYN ? 1 : 0) + (seg.flags & TCP_FIN ? 1 : 0);
    if (seg.flags & TCP_RST) {
      if (seg.seq === c.rcvNxt) this.abort(c, `Connection reset by ${c.remoteIp}`, false);
      return;
    }
    if (segLen > 0 && seg.seq !== c.rcvNxt) {
      const dup = lt(seg.seq, c.rcvNxt);
      this.host.decision(
        'tcp',
        dup
          ? `${this.name} got a duplicate segment [${flags}] seq=${c.relRcv(seg.seq)} it already has: re-ACKing ${c.relRcv(c.rcvNxt)}`
          : `${this.name} got segment seq=${c.relRcv(seg.seq)} but expected ${c.relRcv(c.rcvNxt)}: a segment before it is missing. Discarding it and repeating ACK ${c.relRcv(c.rcvNxt)} (duplicate ACK)`,
      );
      this.emitSeg(c, TCP_ACK, c.sndNxt);
      if (!(seg.flags & TCP_ACK)) return;
    }

    if (seg.flags & TCP_ACK) this.processAck(c, seg);
    if (c.state === 'CLOSED') return;

    if (seg.seq === c.rcvNxt) {
      let ackNeeded = false;
      if (seg.data.length) {
        c.rcvNxt = add(c.rcvNxt, seg.data.length);
        c.bytesReceived += seg.data.length;
        c.segmentsReceived++;
        ackNeeded = true;
        c.cb.onData?.(c, seg.data);
      }
      if (seg.flags & TCP_FIN) {
        c.rcvNxt = add(c.rcvNxt, 1);
        ackNeeded = true;
        if (c.state === 'ESTABLISHED' || c.state === 'SYN_RCVD') {
          this.setState(c, 'CLOSE_WAIT', `${this.name} received FIN from ${c.remoteIp}: the other side is done sending`);
          this.sendAck(c, 'acknowledging their FIN');
          ackNeeded = false;
          c.cb.onPeerClose?.(c);
        } else if (c.state === 'FIN_WAIT_1') {
          this.setState(c, 'CLOSING', `${this.name} received FIN while its own FIN is unacknowledged (simultaneous close)`);
        } else if (c.state === 'FIN_WAIT_2') {
          this.sendAck(c, 'acknowledging their FIN');
          ackNeeded = false;
          this.enterTimeWait(c);
        }
      }
      // Data we send right away carries the ACK too (piggybacking); only send a bare ACK if not.
      this.pump(c);
      if (ackNeeded && c.lastAckSent !== c.rcvNxt) this.sendAck(c, seg.data.length ? `received ${seg.data.length} bytes, next expected byte ${c.relRcv(c.rcvNxt)}` : 'acknowledging their FIN');
      return;
    }
    this.pump(c);
  }

  private processAck(c: TcpConnection, seg: TcpSegment): void {
    if (c.state === 'SYN_RCVD') {
      if (seg.ack !== c.sndNxt) return;
      c.sndUna = seg.ack;
      c.sndWnd = seg.window;
      c.sample(seg.ack);
      c.clearRetransmitFlag();
      c.retries = 0;
      this.stopRto(c);
      c.establishedAt = this.host.engine.now;
      this.setState(c, 'ESTABLISHED', `${this.name} got the final ACK of the handshake from ${c.remoteIp}: connection established (MSS ${c.mss})`);
      c.cb.onEstablished?.(c);
      return;
    }
    c.sndWnd = seg.window;
    if (lt(c.sndUna, seg.ack) && le(seg.ack, c.sndNxt)) {
      const acked = diff(seg.ack, c.sndUna);
      c.sndUna = seg.ack;
      c.dupAcks = 0;
      c.sample(seg.ack);
      c.retries = 0;
      if (c.sndUna === c.sndNxt) {
        c.clearRetransmitFlag();
        this.stopRto(c);
      } else this.armRto(c);
      if (c.finSeq !== null && seg.ack === add(c.finSeq, 1)) {
        if (c.state === 'FIN_WAIT_1') this.setState(c, 'FIN_WAIT_2', `${this.name}'s FIN was acknowledged; waiting for ${c.remoteIp} to close its side`);
        else if (c.state === 'CLOSING') this.enterTimeWait(c);
        else if (c.state === 'LAST_ACK') {
          this.setState(c, 'CLOSED', `${this.name}'s FIN was acknowledged: connection closed`);
          this.finish(c, null);
        }
      } else {
        this.host.decision('tcp', `${this.name} got ACK ${c.relSnd(seg.ack)}: ${acked} more byte(s) confirmed received`);
      }
    } else if (seg.ack === c.sndUna && seg.data.length === 0 && !(seg.flags & (TCP_SYN | TCP_FIN)) && c.sndUna !== c.sndNxt) {
      c.dupAcks++;
      if (c.dupAcks === 3) {
        c.markRetransmit();
        const mss = Math.min(c.mss, this.host.pathMtu(c.remoteIp) - 40);
        const len = Math.min(mss, diff(c.sndNxt, c.sndUna), diff(c.bufEnd, c.sndUna));
        this.host.decision('tcp', `${this.name} got 3 duplicate ACKs for ${c.relSnd(c.sndUna)}: fast retransmit of seq=${c.relSnd(c.sndUna)} without waiting for the timer`);
        if (len > 0) this.emitSeg(c, TCP_ACK, c.sndUna, c.slice(c.sndUna, len));
        this.armRto(c);
      }
    }
  }

  private enterTimeWait(c: TcpConnection): void {
    this.stopRto(c);
    this.setState(c, 'TIME_WAIT', `${this.name} waits 2×MSL (${(2 * MSL) / SEC} s here) in case its last ACK was lost`);
    this.host.engine.schedule(2 * MSL, `${this.name} TIME_WAIT ${c.id}`, () => {
      if (c.state !== 'TIME_WAIT') return;
      this.setState(c, 'CLOSED', `${this.name} TIME_WAIT over: connection closed`);
      this.finish(c, null);
    }, this.host.id);
  }

  private abort(c: TcpConnection, reason: string, sendRst = false): void {
    this.stopRto(c);
    if (sendRst) this.emitSeg(c, TCP_RST, c.sndNxt);
    this.setState(c, 'CLOSED', `${this.name}: ${reason}`);
    this.finish(c, reason);
  }

  private finish(c: TcpConnection, reason: string | null): void {
    this.stopRto(c);
    this.conns.delete(c.id);
    c.cb.onClosed?.(c, reason);
  }

  private setState(c: TcpConnection, s: TcpState, why: string): void {
    const from = c.state;
    c.state = s;
    this.host.table('tcp', from === 'CLOSED' ? 'add' : s === 'CLOSED' ? 'remove' : 'update', c.id, `${why} [${from} → ${s}]`);
  }

  private lowerMss(c: TcpConnection, mss: number, source: string): void {
    if (mss >= c.mss || mss < 8) return;
    this.host.decision('tcp', `${this.name} lowers MSS for ${c.remoteIp}:${c.remotePort} from ${c.mss} to ${mss} (${source}) and resends the unacknowledged data in smaller segments`);
    c.mss = mss;
    if (c.finSeq !== null && le(c.sndUna, c.finSeq)) c.finSeq = null;
    c.sndNxt = c.sndUna;
    c.markRetransmit();
  }

  /** ICMP error quoting one of our segments. Returns true if a connection consumed it. */
  icmpError(remote: Ipv4, localPort: number, remotePort: number, kind: 'needfrag' | 'unreachable', mtu: number, text: string): boolean {
    const local = this.host.ip;
    const c = this.conns.get(`${local}:${localPort}-${remote}:${remotePort}`);
    if (!c) return false;
    if (kind === 'needfrag') {
      this.lowerMss(c, mtu - 40, `ICMP Fragmentation Needed, path MTU ${mtu}`);
      this.pump(c);
      this.armRto(c);
    } else if (c.state === 'SYN_SENT' || c.state === 'SYN_RCVD') {
      // RFC 1122 says soft errors needn't abort; we give up immediately for clarity.
      this.abort(c, text);
    }
    return true;
  }

  rows() {
    return [...this.conns.values()].map((c) => ({
      id: c.id,
      local: `${c.localIp}:${c.localPort}`,
      remote: `${c.remoteIp}:${c.remotePort}`,
      state: c.state,
      role: c.role,
      mss: c.mss,
      sent: c.bytesSent,
      received: c.bytesReceived,
      unacked: diff(c.sndNxt, c.sndUna),
      rtoMs: Math.round(c.rto / MS),
      srttMs: c.srtt === null ? null : Math.round((c.srtt / MS) * 10) / 10,
      retransmissions: c.retransmissions,
    }));
  }
}
