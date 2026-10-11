import { createHash } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const LENGTH = 6;

/** The short name a session goes by: `base32(sha1(id))` cut to 6 chars. */
export function sidOf(id: string): string {
  return base32(createHash("sha1").update(id).digest()).slice(0, LENGTH);
}

/** Six chars of the base32 alphabet, nothing else: a lowercase sid is not a sid. */
export function isSid(s: string): boolean {
  return s.length === LENGTH && [...s].every((c) => ALPHABET.includes(c));
}

/** RFC 4648 base32 without padding; a trailing partial group is zero-filled. */
function base32(bytes: Uint8Array): string {
  let acc = 0;
  let bits = 0;
  let out = "";
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}
