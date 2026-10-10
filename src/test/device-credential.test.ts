import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { bindDeviceIdentity, issueDeviceCredential, verifyDeviceCredential, type DeviceCredential } from "../lib/device-credential";

const root = "fixture-privileged-bearer-" + "a".repeat(40);
const scope: DeviceCredential = {
  version: 1,
  group: "tenant-a",
  storeCode: "store-a",
  installationId: "9cd89667-ae17-4b14-83bc-e7d342541349",
  deviceCode: "installation-9cd89667-ae17-4b14-83bc-e7d342541349",
  credentialId: "c282f93a-a56e-4778-938c-395356a0ad16",
};
test("persistent device credential validates with domain separated signature and bounded schema", () => {
  const token = issueDeviceCredential(scope, root);
  assert.deepEqual(verifyDeviceCredential(token, root), scope);
  assert.equal(token.includes(root), false);
  assert.equal(verifyDeviceCredential(token, root + "wrong"), undefined);
  assert.equal(verifyDeviceCredential(token + "junk", root), undefined);
  assert.equal(verifyDeviceCredential(token + ".extra", root), undefined);
  assert.equal(verifyDeviceCredential("a".repeat(3000), root), undefined);
  assert.equal(verifyDeviceCredential(root, root), undefined);
  const parts = token.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...scope, group: "tenant-b" })).toString("base64url");
  assert.equal(verifyDeviceCredential(parts.join("."), root), undefined);
  const unseparated = token.slice(0, token.lastIndexOf("."));
  assert.equal(verifyDeviceCredential(unseparated + "." + createHmac("sha256", root).update(unseparated).digest("base64url"), root), undefined);
});
test("issuance cannot claim a legacy or foreign device, extra grant or invalid identity", () => {
  for (const changed of [
    { deviceCode: "legacy-host" },
    { group: "" },
    { storeCode: "x y" },
    { installationId: "invalid" },
    { credentialId: "invalid" },
    { admin: true },
  ])
    assert.throws(() => issueDeviceCredential({ ...scope, ...changed }, root));
});
test("all identity dimensions are asserted before any field is changed", () => {
  const missing: Record<string, unknown> = { deviceName: "fixture" };
  assert.equal(bindDeviceIdentity(scope, missing), true);
  assert.equal(missing.group, scope.group);
  assert.equal(missing.deviceCode, scope.deviceCode);
  for (const key of ["group", "storeCode", "installationId", "deviceCode"]) {
    const row = { [key]: "foreign", deviceName: "fixture" };
    const before = structuredClone(row);
    assert.equal(bindDeviceIdentity(scope, row), false);
    assert.deepEqual(row, before);
  }
  assert.equal(bindDeviceIdentity(scope, null), false);
  assert.equal(bindDeviceIdentity(undefined, { deviceCode: "legacy-host" }), true);
});

test("canonical public wire vector remains compatible with the Support issuer", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const vector = JSON.parse(readFileSync(resolve(__dirname, "../../contracts/device-credential-v1.fixture.json"), "utf8")) as {
    signingRoot: string;
    claims: DeviceCredential;
    credential: string;
  };
  assert.equal(issueDeviceCredential(vector.claims, vector.signingRoot), vector.credential);
  assert.deepEqual(verifyDeviceCredential(vector.credential, vector.signingRoot), vector.claims);
});
