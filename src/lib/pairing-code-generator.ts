/**
 * Pairing code generator, ported from `Infrastructure/PairingCodeGenerator.cs`.
 *
 * 8 alphanumeric chars formatted as `XXXX-XXXX`, drawn uniformly from a
 * 32-char Crockford-style alphabet that excludes ambiguous glyphs (I/O/0/1).
 * Uniformity is preserved by masking each random byte with `& 0x1F`
 * (0..255 -> 0..31) — no rejection sampling needed.
 */

import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePairingCode(): string {
  const indexes = randomBytes(8);
  const chars = new Array<string>(8);
  for (let i = 0; i < 8; i++) {
    chars[i] = ALPHABET.charAt(indexes[i]! & 0x1f);
  }
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
}
