// Device credential wire-v1 parity. Canonical writer: catalog-sync. Copy the
// files and this gate after review; do not reimplement them in each Lambda.
// Support's issuer is intentionally JavaScript and shares the public vector.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const SELF_PIN = "e1c8bb3bf6b648ca5842496dd6db6d456638f8b4d307a5760b07e700de13d615";
const PINS = {
  "src/lib/device-credential.ts": "7ba08866f13e61d6c9cacfe1e09961f2a4ea65ddaeaa981696d9c4aae2a07d16",
  "src/lib/shared-bearer-authorizer.ts": "de98ae68b1c80a8fc056329bf611c60ed4cd7521ffb4866477b1605b7578158e",
  "src/test/device-credential.test.ts": "42ecb7c532440778b17f5002951b79ed372bf0c8343d487eec69830721c1e748",
  "contracts/device-credential-v1.fixture.json": "4ab73b4bcbef3adc220ea22c112fe51833d32fe2244897c6de0fbbc1799a9e35",
};
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const consumerName = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name;
const consumers = [
  "label-printer-cloud-catalog-sync",
  "label-printer-cloud-printjob-sync",
  "label-printer-cloud-device-command-claim",
  "label-printer-cloud-device-command-complete",
  "label-printer-cloud-customer-pairing",
  "dmsupport-api-plugin",
];
if (!consumers.includes(consumerName)) throw new Error("Unknown device-credential contract consumer: " + consumerName);
const normalized = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const sha = text => createHash("sha256").update(text).digest("hex");
function check(label, actual, expected) {
  if (actual !== expected) throw new Error(label + " drift: actual SHA256=" + actual + "; review the canonical source before replacing its pin.");
}
const ownSource = normalized(fileURLToPath(import.meta.url));
const mask = /^const SELF_PIN = "[a-f0-9]{64}";$/gm;
if ([...ownSource.matchAll(mask)].length !== 1) throw new Error("The parity self-pin line is missing or ambiguous.");
check("parity gate", sha(ownSource.replace(mask, 'const SELF_PIN = "MASKED";')), SELF_PIN);
for (const [relative, pin] of Object.entries(PINS)) {
  if (consumerName === "dmsupport-api-plugin" && relative.startsWith("src/")) continue;
  check(relative, sha(normalized(path.join(root, relative))), pin);
}
console.log("Device credential v1 contract verified for " + consumerName);
