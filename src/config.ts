/**
 * Env-var-driven config, ported from `Configuration/CustomerPairingLambdaOptions.cs`.
 *
 * Defaults match the C# constants so the Node port stays drop-in compatible
 * with the existing AWS infrastructure (table names, TTL semantics).
 */

export interface CustomerPairingOptions {
  devicesTableName: string;
  pairingCodesTableName: string;
  customerTokensTableName: string;
  pairingCodeTtlSeconds: number;
  bearerTokenSsmParameterName: string;
}

const DEFAULT_DEVICES_TABLE = "DMLabelPrinterCloudDevices";
const DEFAULT_PAIRING_CODES_TABLE = "DMLabelPrinterCloudPairingCodes";
const DEFAULT_CUSTOMER_TOKENS_TABLE = "DMLabelPrinterCloudCustomerTokens";
const DEFAULT_PAIRING_CODE_TTL_SECONDS = 900;
const DEFAULT_BEARER_TOKEN_SSM_PARAMETER = "/dm/label-printer/cloud/shared-bearer-token";

function readValue(key: string, fallback: string): string {
  const raw = process.env[key];
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? fallback : trimmed;
}

export function loadOptions(): CustomerPairingOptions {
  return {
    devicesTableName: readValue("DM_LABEL_PRINTER_CLOUD_DEVICES_TABLE", DEFAULT_DEVICES_TABLE),
    pairingCodesTableName: readValue(
      "DM_LABEL_PRINTER_CLOUD_PAIRING_CODES_TABLE",
      DEFAULT_PAIRING_CODES_TABLE
    ),
    customerTokensTableName: readValue(
      "DM_LABEL_PRINTER_CLOUD_CUSTOMER_TOKENS_TABLE",
      DEFAULT_CUSTOMER_TOKENS_TABLE
    ),
    pairingCodeTtlSeconds: DEFAULT_PAIRING_CODE_TTL_SECONDS,
    bearerTokenSsmParameterName: readValue(
      "DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN_SSM_PARAMETER",
      DEFAULT_BEARER_TOKEN_SSM_PARAMETER
    )
  };
}
