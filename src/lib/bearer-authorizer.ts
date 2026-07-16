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

import { timingSafeEqual } from "node:crypto";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { textResponse, type LambdaResponse } from "./http-results";

const BEARER_PREFIX = "Bearer ";

export interface AuthFailure {
  failure: LambdaResponse;
}

interface GetParameterInput {
  Name: string;
  WithDecryption: boolean;
}

interface GetParameterOutput {
  Parameter?: { Value?: string };
}

interface SsmCommand<TInput, TOutput> {
  readonly input: TInput;
  readonly __output?: TOutput;
}

interface SsmCommandCtor<TInput, TOutput> {
  new (input: TInput): SsmCommand<TInput, TOutput>;
}

interface SsmClient {
  send<TInput, TOutput>(command: SsmCommand<TInput, TOutput>): Promise<TOutput>;
}

interface SsmSdkModule {
  SSMClient: new (config: Record<string, unknown>) => SsmClient;
  GetParameterCommand: SsmCommandCtor<GetParameterInput, GetParameterOutput>;
}

let sdk: SsmSdkModule | undefined;
let ssm: SsmClient | undefined;
const tokenPromises = new Map<string, Promise<string>>();

function getSsm(): { module: SsmSdkModule; client: SsmClient } {
  if (!sdk || !ssm) {
    // AWS SDK v3 is supplied by the managed Node.js Lambda runtime.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sdk = require("@aws-sdk/client-ssm") as SsmSdkModule;
    ssm = new sdk.SSMClient({});
  }
  return { module: sdk, client: ssm };
}

async function loadExpectedToken(parameterName: string): Promise<string> {
  const existing = tokenPromises.get(parameterName);
  if (existing) return existing;

  const current = getSsm();
  const pending = current.client
    .send(new current.module.GetParameterCommand({ Name: parameterName, WithDecryption: true }))
    .then((response) => {
      const value = response.Parameter?.Value?.trim() ?? "";
      if (!value) throw new Error("SSM bearer parameter returned no usable value");
      return value;
    })
    .catch((error: unknown) => {
      tokenPromises.delete(parameterName);
      throw error;
    });
  tokenPromises.set(parameterName, pending);
  return pending;
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function extractSharedBearer(
  event: LambdaFunctionURLEvent
): string | undefined | null {
  const headerValue = getAuthorizationHeader(event);
  if (headerValue === undefined) return undefined;
  if (!startsWithCaseInsensitive(headerValue, BEARER_PREFIX)) return null;
  return headerValue.slice(BEARER_PREFIX.length).trim();
}

export async function authorize(
  event: LambdaFunctionURLEvent,
  parameterName: string
): Promise<AuthFailure | null> {
  const token = extractSharedBearer(event);
  if (token === undefined) {
    return { failure: textResponse(401, "Missing Authorization header") };
  }
  if (token === null) {
    return { failure: textResponse(401, "Invalid Authorization header") };
  }
  const expected = await loadExpectedToken(parameterName);
  if (!tokensEqual(token, expected)) {
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
