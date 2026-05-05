/**
 * `pairingCodes` Lambda handler — POST /api/v1/pairing/codes
 *
 * Device-side endpoint. Authenticated by the cloud bearer token. Given a
 * `deviceCode`, looks up the device's `Group` (= storeId), allocates a fresh
 * (collision-checked) pairing code into `DMLabelPrinterCloudPairingCodes`, and
 * returns `{ code, expiresAtUtc }`.
 *
 * Ported verbatim from `Handlers/CreatePairingCodeFunction.cs`.
 */

// Module-level idempotent BigInt.prototype.toJSON shim — mandatory per
// dmngr/lambda-policies harden phase. DynamoDB N attributes can come back as
// BigInt via unmarshall(...) and would otherwise crash JSON.stringify(...).
if (typeof BigInt === "function" && !BigInt.prototype.toJSON) {
  Object.defineProperty(BigInt.prototype, "toJSON", {
    value: function () {
      return this.toString();
    },
    configurable: true,
    writable: true,
  });
}

import type { APIGatewayProxyHandlerV2, LambdaFunctionURLEvent } from "aws-lambda";

import { loadOptions } from "../config";
import { authorize } from "../lib/bearer-authorizer";
import {
  jsonResponse,
  noContentResponse,
  textResponse,
  validationProblemResponse,
  type LambdaResponse
} from "../lib/http-results";
import {
  CustomError,
  logHandledErrorAction,
  redactDeep,
  shouldSuppress
} from "../lib/handled-errors";
import { generatePairingCode } from "../lib/pairing-code-generator";
import { DynamoCustomerPairingStore } from "../storage/dynamo-store";
import type { CreatePairingCodeRequest, CreatePairingCodeResponse } from "../types";

const PATH = "/api/v1/pairing/codes";
const MAX_CODE_ATTEMPTS = 5;

function getMethod(event: LambdaFunctionURLEvent): string {
  return event.requestContext?.http?.method ?? "";
}

function isOptions(event: LambdaFunctionURLEvent): boolean {
  return getMethod(event).toUpperCase() === "OPTIONS";
}

function normalizePath(rawPath: string | null | undefined): string {
  if (!rawPath || rawPath.trim().length === 0) return "/";
  return rawPath.trim();
}

function isAllowedPath(rawPath: string | null | undefined, expected: string): boolean {
  const normalized = normalizePath(rawPath);
  return normalized === "/" || normalized.toLowerCase() === expected.toLowerCase();
}

function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function epochToIso(epochSeconds: number): string {
  // YYYY-MM-DDTHH:MM:SSZ — matches `yyyy-MM-ddTHH:mm:ssZ` from the C# version.
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const handler: APIGatewayProxyHandlerV2 = async (event, context) => {
  const fnEvent = event as LambdaFunctionURLEvent;
  const awsRequestId = context?.awsRequestId;
  console.log("ctx", { handler: "pairingCodes", awsRequestId });

  try {
    const options = loadOptions();

    if (isOptions(fnEvent)) {
      console.log("RequestId SUCCESS");
      return noContentResponse();
    }

    const authFailure = authorize(fnEvent, options);
    if (authFailure !== null) {
      const code = "customer_pairing_unauthorized";
      logHandledErrorAction(code, shouldSuppress(code));
      return authFailure.failure;
    }

    if (getMethod(fnEvent).toUpperCase() !== "POST") {
      return textResponse(405, "Method not allowed");
    }

    if (!isAllowedPath(fnEvent.rawPath, PATH)) {
      return textResponse(404, "Not found");
    }

    let payload: CreatePairingCodeRequest | null;
    try {
      payload = parseBody<CreatePairingCodeRequest>(fnEvent.body);
    } catch (err) {
      console.log("invalid_json", { message: (err as Error).message });
      const code = "customer_pairing_invalid_json_body";
      logHandledErrorAction(code, shouldSuppress(code));
      return textResponse(400, "Invalid JSON body");
    }

    const deviceCode = (payload?.deviceCode ?? "").toString().trim();
    if (deviceCode.length === 0) {
      const code = "customer_pairing_invalid_params";
      logHandledErrorAction(code, shouldSuppress(code));
      return validationProblemResponse({
        deviceCode: ["deviceCode is required."]
      });
    }

    const store = new DynamoCustomerPairingStore(options);
    const group = await store.getDeviceGroup(deviceCode);
    if (group === null) {
      const code = "customer_pairing_device_not_found";
      logHandledErrorAction(code, shouldSuppress(code));
      return textResponse(404, "Device not found");
    }
    if (group.length === 0) {
      const code = "customer_pairing_no_store_assignment";
      logHandledErrorAction(code, shouldSuppress(code));
      return textResponse(409, "device has no store assignment");
    }

    const now = nowEpochSeconds();
    const expiresEpoch = now + options.pairingCodeTtlSeconds;

    let code: string | null = null;
    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const candidate = generatePairingCode();
      const existing = await store.getPairingCode(candidate);
      // Free if no row, or row exists but its TTL has already elapsed.
      if (existing === null || existing.expiresAtUtc < now) {
        code = candidate;
        break;
      }
    }

    if (code === null) {
      console.log("pairing_code_collision", { attempts: MAX_CODE_ATTEMPTS });
      const errorCode = "customer_pairing_code_collision";
      logHandledErrorAction(errorCode, shouldSuppress(errorCode));
      return textResponse(503, "Could not allocate pairing code, try again");
    }

    await store.putPairingCode({
      code,
      deviceCode,
      storeId: group,
      expiresAtUtc: expiresEpoch
    });

    const response: CreatePairingCodeResponse = {
      code,
      expiresAtUtc: epochToIso(expiresEpoch)
    };

    console.log("RequestId SUCCESS");
    return jsonResponse(201, response);
  } catch (error) {
    // Final generic catch — log redacted event once, structured error summary,
    // and a handled-error marker if it was a CustomError. Never emit
    // RequestId SUCCESS from here.
    console.log("event", JSON.stringify(redactDeep(event)));
    if (error instanceof CustomError) {
      logHandledErrorAction(error.code, shouldSuppress(error.code));
    }
    console.log("unhandled_error", {
      awsRequestId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    console.log("RequestId FAILED");

    const fallback: LambdaResponse = textResponse(500, "Internal Server Error");
    return fallback;
  }
};

function parseBody<T>(body: string | null | undefined): T | null {
  if (body === null || body === undefined || body.length === 0) return null;
  return JSON.parse(body) as T;
}
