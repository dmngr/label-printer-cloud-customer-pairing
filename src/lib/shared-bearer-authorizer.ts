import { timingSafeEqual } from "node:crypto";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { verifyDeviceCredential, type DeviceIdentity } from "./device-credential";

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

export type BearerResult = { kind: "ok"; device?: DeviceIdentity } | { kind: "missing" } | { kind: "invalid_header" } | { kind: "invalid_token" };

export function extractBearer(event: LambdaFunctionURLEvent): string | undefined | null {
  const entry = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization");
  if (!entry || typeof entry[1] !== "string" || !entry[1].trim()) return undefined;
  if (!entry[1].toLowerCase().startsWith("bearer ")) return null;
  const token = entry[1].slice("Bearer ".length).trim();
  return token ? token : null;
}

async function loadExpectedToken(parameterName: string): Promise<string> {
  const existing = tokenPromises.get(parameterName);
  if (existing) return existing;
  const runtime = getSsm();
  const pending = runtime.client
    .send(new runtime.module.GetParameterCommand({ Name: parameterName, WithDecryption: true }))
    .then(response => {
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
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export async function authorizeSharedBearer(
  event: LambdaFunctionURLEvent,
  parameterName: string,
  allowDeviceCredential = false,
): Promise<BearerResult> {
  const bearer = extractBearer(event);
  if (bearer === undefined) return { kind: "missing" };
  if (bearer === null) return { kind: "invalid_header" };
  const expected = await loadExpectedToken(parameterName);
  if (tokensEqual(bearer, expected)) return { kind: "ok" };
  const device = allowDeviceCredential ? verifyDeviceCredential(bearer, expected) : undefined;
  return device ? { kind: "ok", device } : { kind: "invalid_token" };
}
