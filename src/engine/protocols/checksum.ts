/** RFC 1071 Internet checksum: one's-complement of the one's-complement sum of 16-bit words.
 * An odd trailing byte is padded with zero on the right. */
export function internetChecksum(data: Uint8Array, start = 0, end = data.length): number {
  let sum = 0;
  let i = start;
  for (; i + 1 < end; i += 2) {
    sum += (data[i]! << 8) | data[i + 1]!;
  }
  if (i < end) sum += data[i]! << 8;
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

/** A buffer containing a correct checksum field sums (with the checksum) to 0xffff,
 * so the checksum over it is 0. */
export function checksumValid(data: Uint8Array, start = 0, end = data.length): boolean {
  return internetChecksum(data, start, end) === 0;
}
