/** Byte-level writer/reader that records which header field produced each byte range.
 * The span map drives the hex view's field <-> byte highlighting. */

export type LayerName = 'Ethernet II' | 'ARP' | 'IPv4' | 'ICMP' | 'UDP' | 'TCP' | 'Data';

export interface FieldSpan {
  layer: LayerName;
  /** Stable key, e.g. "ipv4.ttl". */
  key: string;
  label: string;
  /** Byte range [start, end). */
  start: number;
  end: number;
  /** Human-readable decoded value. */
  display: string;
  /** For sub-byte fields: bit mask within the first byte of the range, MSB-first notation like "1111 ....". */
  bits?: string;
}

export interface LayerSpan {
  layer: LayerName;
  start: number;
  end: number;
}

export class ByteWriter {
  private buf: Uint8Array;
  private len = 0;
  readonly fields: FieldSpan[] = [];
  readonly layers: LayerSpan[] = [];

  constructor(capacity = 256) {
    this.buf = new Uint8Array(capacity);
  }

  get length(): number {
    return this.len;
  }

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.buf[this.len++] = (v >>> 24) & 0xff;
    this.buf[this.len++] = (v >>> 16) & 0xff;
    this.buf[this.len++] = (v >>> 8) & 0xff;
    this.buf[this.len++] = v & 0xff;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }

  /** Overwrite a 16-bit value already written (used to patch checksums). */
  patchU16(offset: number, v: number): void {
    this.buf[offset] = (v >>> 8) & 0xff;
    this.buf[offset + 1] = v & 0xff;
  }

  /** Record a field span around whatever `write` emits. */
  field(layer: LayerName, key: string, label: string, display: string, write: () => void, bits?: string): void {
    const start = this.len;
    write();
    const span: FieldSpan = { layer, key, label, start, end: this.len, display };
    if (bits !== undefined) span.bits = bits;
    this.fields.push(span);
  }

  /** Record a sub-byte field that shares bytes already (or about to be) written. */
  bitField(layer: LayerName, key: string, label: string, display: string, start: number, end: number, bits: string): void {
    this.fields.push({ layer, key, label, start, end, display, bits });
  }

  layer(layer: LayerName, write: () => void): void {
    const start = this.len;
    write();
    this.layers.push({ layer, start, end: this.len });
  }

  view(start: number, end: number): Uint8Array {
    return this.buf.subarray(start, end);
  }

  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class ByteReader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    offset = 0,
    readonly end = buf.length,
  ) {
    this.pos = offset;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number): void {
    if (this.pos + n > this.end) {
      throw new RangeError(`Truncated packet: need ${n} bytes at offset ${this.pos}, have ${this.remaining}`);
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++]!;
  }

  u16(): number {
    this.need(2);
    const v = (this.buf[this.pos]! << 8) | this.buf[this.pos + 1]!;
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v =
      ((this.buf[this.pos]! << 24) | (this.buf[this.pos + 1]! << 16) | (this.buf[this.pos + 2]! << 8) | this.buf[this.pos + 3]!) >>> 0;
    this.pos += 4;
    return v;
  }

  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  rest(): Uint8Array {
    return this.bytes(this.remaining);
  }
}

export function hex(n: number, width: number): string {
  return '0x' + n.toString(16).padStart(width, '0');
}

export function toHexString(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
}

export function fromHexString(s: string): Uint8Array {
  const clean = s.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2 !== 0) throw new Error('Odd-length hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
