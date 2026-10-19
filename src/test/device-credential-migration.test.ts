import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { bindDeviceIdentity, issueDeviceCredential, verifyDeviceCredential, type DeviceCredential } from "../lib/device-credential";

const v1 = JSON.parse(readFileSync(resolve(__dirname, "../../contracts/device-credential-v1.fixture.json"), "utf8")) as {
  signingRoot: string;
  claims: DeviceCredential;
  credential: string;
};
const scope: DeviceCredential = { ...v1.claims, version: 2, deviceCode: "LEGACY-FIXTURE" };
test("migration preserves the existing code with a separate signed version and unchanged v1 acceptance", () => {
  const token = issueDeviceCredential(scope, v1.signingRoot);
  assert.deepEqual(verifyDeviceCredential(token, v1.signingRoot), scope);
  assert.equal(issueDeviceCredential(v1.claims, v1.signingRoot), v1.credential);
  assert.deepEqual(verifyDeviceCredential(v1.credential, v1.signingRoot), v1.claims);
  assert.throws(() => issueDeviceCredential({ ...scope, version: 1 }, v1.signingRoot));
  for (const code of ["", "with space", "x".repeat(129), "../foreign"]) {
    assert.throws(() => issueDeviceCredential({ ...scope, deviceCode: code }, v1.signingRoot));
  }
  for (const field of ["group", "storeCode", "deviceCode", "installationId"]) {
    const device = { ...scope, [field]: "foreign" };
    assert.equal(bindDeviceIdentity(scope, device), false);
  }
});
test("prefix version payload and signing domain cannot be mixed even with well-formed signatures", () => {
  const token = issueDeviceCredential(scope, v1.signingRoot);
  assert.equal(verifyDeviceCredential(token.replace("ln-device-v2.", "ln-device-v1."), v1.signingRoot), undefined);
  for (const claims of [{ ...v1.claims }, { ...scope, version: 3 }, { ...scope, admin: true }]) {
    const message = "ln-device-v2." + Buffer.from(JSON.stringify(claims)).toString("base64url");
    const key = createHmac("sha256", v1.signingRoot).update("label-ninja/device-credential-signing/v2").digest();
    assert.equal(verifyDeviceCredential(message + "." + createHmac("sha256", key).update(message).digest("base64url"), v1.signingRoot), undefined);
  }
  assert.equal(verifyDeviceCredential(token + "x", v1.signingRoot), undefined);
  assert.equal(verifyDeviceCredential(token, v1.signingRoot + "wrong"), undefined);
});
