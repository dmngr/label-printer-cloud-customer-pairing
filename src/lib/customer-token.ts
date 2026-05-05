/**
 * Customer bearer mint + hash, ported from `Infrastructure/CustomerTokenHelper.cs`.
 *
 * - `createBearer()`: 32 random bytes -> base64url, no padding (~256 bits).
 * - `sha256Hex(value)`: lowercase-hex SHA-256 of the UTF-8 input.
 */

import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTE_LENGTH = 32;

export function createBearer(): string {
  return base64UrlNoPadding(randomBytes(TOKEN_BYTE_LENGTH));
}

export function sha256Hex(value: string | null | undefined): string {
  const buf = Buffer.from(typeof value === "string" ? value : "", "utf8");
  return createHash("sha256").update(buf).digest("hex");
}

function base64UrlNoPadding(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
