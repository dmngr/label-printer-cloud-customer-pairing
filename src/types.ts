/**
 * Shared types for the customer-pairing Lambda.
 *
 * Mirrors the C# `Models/CustomerPairingModels.cs` shapes verbatim so the wire
 * contract stays compatible with the device-side and web-side clients.
 */

export interface CreatePairingCodeRequest {
  deviceCode?: string | null;
}

export interface CreatePairingCodeResponse {
  code: string;
  expiresAtUtc: string;
}

export interface ClaimPairingCodeRequest {
  code?: string | null;
}

export interface ClaimPairingCodeResponse {
  bearer: string;
  stores: ReadonlyArray<string>;
}

export interface PairingCodeRecord {
  code: string;
  deviceCode: string;
  storeId: string;
  /** Unix epoch seconds; matches DynamoDB TTL attribute `ExpiresAtUtc`. */
  expiresAtUtc: number;
}

export interface CustomerTokenRecord {
  tokenHash: string;
  storeIds: string[];
  createdAtUtc: string;
  lastUsedAtUtc: string;
}
