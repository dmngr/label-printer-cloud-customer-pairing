/**
 * Smoke tests — verify the handlers can be loaded without crashing the
 * runtime, and that the pairing-code generator produces strings shaped like
 * `XXXX-XXXX` over the Crockford-style alphabet (no I/O/0/1).
 *
 * Run via the compiled JS output: `npm run build && node --test dist/test`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

test("pairing-code-generator emits XXXX-XXXX from the unambiguous alphabet", async () => {
  const { generatePairingCode } = await import("../lib/pairing-code-generator");
  const allowed = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

  for (let i = 0; i < 100; i++) {
    const code = generatePairingCode();
    assert.equal(code.length, 9, `unexpected length: ${code}`);
    assert.ok(allowed.test(code), `code does not match alphabet/format: ${code}`);
    // Belt-and-braces: explicitly forbid the ambiguous glyphs.
    assert.ok(!/[IO01]/.test(code), `code contains ambiguous char: ${code}`);
  }
});

test("customer-token mints a 32-byte base64url bearer with matching sha256 hash", async () => {
  const { createBearer, sha256Hex } = await import("../lib/customer-token");

  const bearer = createBearer();
  // 32 bytes -> 43 chars base64url (no padding).
  assert.equal(bearer.length, 43);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(bearer), `bearer not base64url: ${bearer}`);

  const hash = sha256Hex(bearer);
  assert.equal(hash.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(hash), `hash not lowercase hex: ${hash}`);
});

test("handler entrypoints compile cleanly to dist/", async () => {
  // We can't import the handlers under `node --test` locally because they
  // pull in `@aws-sdk/client-dynamodb` (runtime-included on Node 18+ Lambda
  // runtimes; intentionally NOT pinned in package.json per Phase 4). So
  // instead we assert the compiled handler files exist and were emitted by
  // tsc — that's enough to catch a missing-export / build-broken regression.
  const fs = await import("node:fs");
  const path = await import("node:path");

  const codesEntry = path.resolve(__dirname, "..", "handlers", "pairing-codes.js");
  const claimEntry = path.resolve(__dirname, "..", "handlers", "pairing-claim.js");

  assert.ok(fs.existsSync(codesEntry), `missing compiled handler: ${codesEntry}`);
  assert.ok(fs.existsSync(claimEntry), `missing compiled handler: ${claimEntry}`);

  const codesSource = fs.readFileSync(codesEntry, "utf8");
  const claimSource = fs.readFileSync(claimEntry, "utf8");
  assert.match(codesSource, /exports\.handler\s*=/);
  assert.match(claimSource, /exports\.handler\s*=/);
});

test("redactDeep replaces sensitive header values but keeps the schema", async () => {
  const { redactDeep } = await import("../lib/handled-errors");

  const event = {
    headers: { authorization: "Bearer s3cret", "x-api-key": "k1", accept: "application/json" },
    body: '{"foo":"bar"}'
  };

  const redacted = redactDeep(event) as { headers: Record<string, string>; body: string };
  assert.equal(redacted.headers["authorization"], "[REDACTED]");
  assert.equal(redacted.headers["x-api-key"], "[REDACTED]");
  assert.equal(redacted.headers["accept"], "application/json");
  assert.equal(redacted.body, '{"foo":"bar"}');
});

test("handled-error policy lookup falls back to false for unknown codes", async () => {
  const { shouldSuppress } = await import("../lib/handled-errors");
  assert.equal(shouldSuppress("totally_unknown_code_12345"), false);
});
