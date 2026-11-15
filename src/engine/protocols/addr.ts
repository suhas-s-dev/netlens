/** Address helpers. MACs and IPv4 addresses are kept as canonical strings in headers
 * (readable in traces / JSON) and converted to bytes / uint32 at the edges. */

export type Mac = string; // "aa:bb:cc:dd:ee:ff" (lower-case)
export type Ipv4 = string; // "10.0.0.1"

export const BROADCAST_MAC: Mac = 'ff:ff:ff:ff:ff:ff';
export const ZERO_MAC: Mac = '00:00:00:00:00:00';
export const LIMITED_BROADCAST: Ipv4 = '255.255.255.255';

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function isValidMac(s: string): boolean {
  return MAC_RE.test(s.toLowerCase());
}

export function macToBytes(mac: Mac): Uint8Array {
  if (!isValidMac(mac)) throw new Error(`Invalid MAC: ${mac}`);
  return Uint8Array.from(mac.split(':').map((h) => parseInt(h, 16)));
}

export function bytesToMac(b: Uint8Array, offset = 0): Mac {
  const parts: string[] = [];
  for (let i = 0; i < 6; i++) parts.push((b[offset + i] ?? 0).toString(16).padStart(2, '0'));
  return parts.join(':');
}

export function isBroadcastMac(mac: Mac): boolean {
  return mac === BROADCAST_MAC;
}

/** Group bit (I/G) set: broadcast or multicast. */
export function isGroupMac(mac: Mac): boolean {
  return (parseInt(mac.slice(0, 2), 16) & 1) === 1;
}

export function isValidIp(s: string): boolean {
  const m = IP_RE.exec(s);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255 && String(Number(o)) === o);
}

export function ipToInt(ip: Ipv4): number {
  const m = IP_RE.exec(ip);
  if (!m || !isValidIp(ip)) throw new Error(`Invalid IPv4 address: ${ip}`);
  return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
}

export function intToIp(n: number): Ipv4 {
  n = n >>> 0;
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

export function ipToBytes(ip: Ipv4): Uint8Array {
  const n = ipToInt(ip);
  return Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

export function bytesToIp(b: Uint8Array, offset = 0): Ipv4 {
  return `${b[offset] ?? 0}.${b[offset + 1] ?? 0}.${b[offset + 2] ?? 0}.${b[offset + 3] ?? 0}`;
}

export function prefixToMask(prefix: number): number {
  if (prefix < 0 || prefix > 32) throw new Error(`Invalid prefix length: ${prefix}`);
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function maskToString(prefix: number): string {
  return intToIp(prefixToMask(prefix));
}

export function networkOf(ip: Ipv4, prefix: number): Ipv4 {
  return intToIp((ipToInt(ip) & prefixToMask(prefix)) >>> 0);
}

export function broadcastOf(ip: Ipv4, prefix: number): Ipv4 {
  return intToIp((ipToInt(ip) | ~prefixToMask(prefix)) >>> 0);
}

export function inSubnet(ip: Ipv4, network: Ipv4, prefix: number): boolean {
  const mask = prefixToMask(prefix);
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(network) & mask) >>> 0);
}

/** True when two prefixes share any address. */
export function subnetsOverlap(a: Ipv4, aPrefix: number, b: Ipv4, bPrefix: number): boolean {
  const p = Math.min(aPrefix, bPrefix);
  return inSubnet(a, b, p);
}

export function formatCidr(ip: Ipv4, prefix: number): string {
  return `${ip}/${prefix}`;
}

export function parseCidr(s: string): { ip: Ipv4; prefix: number } {
  const [ip, p] = s.split('/');
  const prefix = Number(p);
  if (!ip || !isValidIp(ip) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR: ${s}`);
  }
  return { ip, prefix };
}
