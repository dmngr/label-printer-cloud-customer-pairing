/** Device credential v1. Canonical source: catalog-sync; consumers COPY this
 * file and its parity gate. The SSM privileged bearer stays server-side and is
 * domain-separated before signing. Existing privileged callers keep their
 * contract; new installation credentials carry immutable tenant/device scope.
 * These are persistent installation credentials, not expiring browser sessions.
 * Enrollment transport has its own short expiry and one-use challenge.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface DeviceIdentity {
  group: string;
  storeCode: string;
  installationId: string;
  deviceCode: string;
}
export interface DeviceCredential extends DeviceIdentity {
  version: 1;
  credentialId: string;
}
export const DEVICE_CREDENTIAL_PREFIX = "ln-device-v1.";
const DOMAIN = "label-ninja/device-credential-signing/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const KEYS = ["credentialId", "deviceCode", "group", "installationId", "storeCode", "version"];
export const DEVICE_OWNERSHIP_CONDITION =
  "attribute_not_exists(DeviceCode) OR (#g = :group AND StoreCode = :storeCode AND InstallationId = :installationId)";
export class DeviceScopeConflict extends Error {
  constructor() {
    super("Device scope mismatch");
    this.name = "DeviceScopeConflict";
  }
}

export async function guardedDeviceWrite<T>(write: () => Promise<T>, scoped: boolean): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (scoped && error instanceof Error && error.name === "ConditionalCheckFailedException") throw new DeviceScopeConflict();
    throw error;
  }
}

export function validDeviceCredential(value: unknown): value is DeviceCredential {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).sort().join(",") === KEYS.join(",") &&
    row.version === 1 &&
    typeof row.group === "string" &&
    ID.test(row.group) &&
    typeof row.storeCode === "string" &&
    ID.test(row.storeCode) &&
    typeof row.installationId === "string" &&
    UUID.test(row.installationId) &&
    typeof row.credentialId === "string" &&
    UUID.test(row.credentialId) &&
    row.deviceCode === "installation-" + row.installationId
  );
}

function signature(message: string, privilegedBearer: string): Buffer {
  const key = createHmac("sha256", privilegedBearer).update(DOMAIN).digest();
  return createHmac("sha256", key).update(message).digest();
}

/** Used only by an authorized issuer. Never return the signing key or log token. */
export function issueDeviceCredential(value: DeviceCredential, privilegedBearer: string): string {
  if (!validDeviceCredential(value) || privilegedBearer.length < 32) throw new Error("Invalid credential issuance input");
  const message = DEVICE_CREDENTIAL_PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
  return message + "." + signature(message, privilegedBearer).toString("base64url");
}

export function verifyDeviceCredential(token: string, privilegedBearer: string): DeviceCredential | undefined {
  if (token.length > 2048 || privilegedBearer.length < 32 || !token.startsWith(DEVICE_CREDENTIAL_PREFIX)) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[2])) return undefined;
  const actual = Buffer.from(parts[2], "base64url");
  const expected = signature(parts[0] + "." + parts[1], privilegedBearer);
  if (actual.length !== expected.length || actual.toString("base64url") !== parts[2] || !timingSafeEqual(actual, expected)) return undefined;
  try {
    const bytes = Buffer.from(parts[1], "base64url");
    if (bytes.toString("base64url") !== parts[1]) return undefined;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return validDeviceCredential(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Missing identity fields inherit authority. Contradictions fail before access;
 * never silently correct a supplied foreign identity. Call on the parsed device
 * (whose casing/duplicate-property policy is already defined by each endpoint).
 */
export function bindDeviceIdentity(scope: DeviceIdentity | undefined, device: object | null | undefined): boolean {
  if (!scope) return true;
  if (!device || typeof device !== "object" || Array.isArray(device)) return false;
  const row = device as Record<string, unknown>;
  const keys = ["group", "storeCode", "installationId", "deviceCode"] as const;
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && value !== "" && (typeof value !== "string" || value.trim() !== scope[key])) return false;
  }
  for (const key of keys) row[key] = scope[key];
  return true;
}
