/**
 * Bearer token authorization helper, ported from
 * `Infrastructure/BearerTokenAuthorizer.cs`.
 *
 * Two responsibilities (kept separate as in C#):
 * - `authorize`: gate the device-side endpoint with the cloud bearer.
 * - `tryExtractBearer`: pull whatever bearer the caller sent, without rejecting
 *   the request. Used by the claim endpoint to merge stores into an existing
 *   customer token row when the customer already has one.
 */

import type { LambdaFunctionURLEvent } from "aws-lambda";
import type { CustomerPairingOptions } from "../config";
import { textResponse, type LambdaResponse } from "./http-results";

const BEARER_PREFIX = "Bearer ";

export interface AuthFailure {
  failure: LambdaResponse;
}

export function authorize(
  event: LambdaFunctionURLEvent,
  options: CustomerPairingOptions
): AuthFailure | null {
  if (!options.isAuthEnabled) return null;

  const headerValue = getAuthorizationHeader(event);
  if (headerValue === undefined) {
    return { failure: textResponse(401, "Missing Authorization header") };
  }

  if (!startsWithCaseInsensitive(headerValue, BEARER_PREFIX)) {
    return { failure: textResponse(401, "Invalid Authorization header") };
  }

  const token = headerValue.slice(BEARER_PREFIX.length).trim();
  if (token !== options.bearerToken) {
    return { failure: textResponse(401, "Invalid bearer token") };
  }

  return null;
}

export function tryExtractBearer(event: LambdaFunctionURLEvent): string | null {
  const headerValue = getAuthorizationHeader(event);
  if (headerValue === undefined) return null;
  if (!startsWithCaseInsensitive(headerValue, BEARER_PREFIX)) return null;
  const token = headerValue.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function getAuthorizationHeader(event: LambdaFunctionURLEvent): string | undefined {
  const headers = event.headers;
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization" && typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function startsWithCaseInsensitive(value: string, prefix: string): boolean {
  if (value.length < prefix.length) return false;
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}
