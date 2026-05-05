/**
 * `pairingClaim` Lambda handler — POST /api/v1/pairing/claim
 *
 * Web-side endpoint. **No required auth** at the gate: if the caller already
 * holds a valid customer bearer, we append the new store to that token row;
 * otherwise we mint a fresh customer bearer. After either branch the pairing
 * code row is deleted.
 *
 * Ported verbatim from `Handlers/ClaimPairingCodeFunction.cs`.
 */

import type { APIGatewayProxyHandlerV2, LambdaFunctionURLEvent } from "aws-lambda";

import { loadOptions } from "../config";
import { tryExtractBearer } from "../lib/bearer-authorizer";
import { createBearer, sha256Hex } from "../lib/customer-token";
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
import { DynamoCustomerPairingStore } from "../storage/dynamo-store";
import type { ClaimPairingCodeRequest, ClaimPairingCodeResponse } from "../types";

const PATH = "/api/v1/pairing/claim";

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

function nowIsoSeconds(): string {
  // YYYY-MM-DDTHH:MM:SSZ — matches `yyyy-MM-ddTHH:mm:ssZ` from the C# version.
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export const handler: APIGatewayProxyHandlerV2 = async (event, context) => {
  const fnEvent = event as LambdaFunctionURLEvent;
  const awsRequestId = context?.awsRequestId;
  console.log("ctx", { handler: "pairingClaim", awsRequestId });

  try {
    const options = loadOptions();

    if (isOptions(fnEvent)) {
      console.log("RequestId SUCCESS");
      return noContentResponse();
    }

    if (getMethod(fnEvent).toUpperCase() !== "POST") {
      return textResponse(405, "Method not allowed");
    }

    if (!isAllowedPath(fnEvent.rawPath, PATH)) {
      return textResponse(404, "Not found");
    }

    let payload: ClaimPairingCodeRequest | null;
    try {
      payload = parseBody<ClaimPairingCodeRequest>(fnEvent.body);
    } catch (err) {
      console.log("invalid_json", { message: (err as Error).message });
      const code = "customer_pairing_invalid_json_body";
      logHandledErrorAction(code, shouldSuppress(code));
      return textResponse(400, "Invalid JSON body");
    }

    const code = (payload?.code ?? "").toString().trim();
    if (code.length === 0) {
      const errorCode = "customer_pairing_invalid_params";
      logHandledErrorAction(errorCode, shouldSuppress(errorCode));
      return validationProblemResponse({
        code: ["code is required."]
      });
    }

    const store = new DynamoCustomerPairingStore(options);
    const pairing = await store.getPairingCode(code);
    if (pairing === null) {
      const errorCode = "customer_pairing_code_not_found";
      logHandledErrorAction(errorCode, shouldSuppress(errorCode));
      return textResponse(404, "Pairing code not found");
    }

    const now = nowEpochSeconds();
    if (pairing.expiresAtUtc <= now) {
      const errorCode = "customer_pairing_code_expired";
      logHandledErrorAction(errorCode, shouldSuppress(errorCode));
      return textResponse(410, "Pairing code expired");
    }

    const storeId = (pairing.storeId ?? "").trim();
    if (storeId.length === 0) {
      console.log("pairing_code_missing_store", { code });
      const errorCode = "customer_pairing_code_missing_store";
      logHandledErrorAction(errorCode, shouldSuppress(errorCode));
      return textResponse(409, "Pairing code is missing a store assignment");
    }

    const nowIso = nowIsoSeconds();
    const incomingBearer = tryExtractBearer(fnEvent);

    if (incomingBearer !== null) {
      const incomingHash = sha256Hex(incomingBearer);
      const existing = await store.getCustomerToken(incomingHash);
      if (existing !== null) {
        const stores = await store.appendStoreToCustomerToken(
          incomingHash,
          storeId,
          nowIso
        );
        await store.deletePairingCode(code);

        const response: ClaimPairingCodeResponse = {
          bearer: incomingBearer,
          stores
        };
        console.log("RequestId SUCCESS");
        return jsonResponse(200, response);
      }
      // Bearer present but unknown — fall through to fresh mint, treating it as if absent.
    }

    const freshBearer = createBearer();
    const freshHash = sha256Hex(freshBearer);

    await store.putCustomerToken({
      tokenHash: freshHash,
      storeIds: [storeId],
      createdAtUtc: nowIso,
      lastUsedAtUtc: nowIso
    });
    await store.deletePairingCode(code);

    const response: ClaimPairingCodeResponse = {
      bearer: freshBearer,
      stores: [storeId]
    };
    console.log("RequestId SUCCESS");
    return jsonResponse(200, response);
  } catch (error) {
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
