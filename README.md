# label-printer-cloud-customer-pairing

Customer-pairing Lambda for the DM Label Printer customer-facing web app at
[app.label.ninja](https://app.label.ninja). Two handlers are shipped in this
single bundle, each fronted by its own Lambda Function URL (no API Gateway):

| Endpoint | Method | Side | Auth |
|---|---|---|---|
| `/api/v1/pairing/codes` | POST | device-side | Bearer `DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN` |
| `/api/v1/pairing/claim` | POST | web-side | optional bearer (used to merge stores into an existing customer token) |

This is a Node.js (TypeScript) port of the original .NET prototype that lived
in [`dmngr/label-printers-panel`](https://github.com/dmngr/label-printers-panel)
under `src/LabelPrinter.CloudLambda.CustomerPairing/`. The .NET version is
being retired in favor of this dedicated repo, in line with the team pattern
of one Lambda repo per Lambda function bundle. See the design doc:
<https://github.com/dmngr/label-printers-panel/blob/main/docs/app-label-ninja-design.md>.

## Layout

- `src/handlers/pairing-codes.ts` — device-side handler entry, `export const handler`
- `src/handlers/pairing-claim.ts` — web-side handler entry, `export const handler`
- `src/storage/dynamo-store.ts` — DynamoDB store (low-level `@aws-sdk/client-dynamodb`)
- `src/lib/pairing-code-generator.ts` — `XXXX-XXXX` code generator (Crockford-style alphabet)
- `src/lib/customer-token.ts` — bearer mint (32-byte base64url) + sha256 hex hash
- `src/lib/bearer-authorizer.ts` — header-based bearer matcher
- `src/lib/http-results.ts` — Function URL response helpers (CORS, JSON, validation problem)
- `src/lib/handled-errors.ts` — handled-errors `ACTION:SLACK_HANDLED_ERROR_HE1=` marker
- `src/types.ts` — wire model interfaces (mirror `Models/CustomerPairingModels.cs`)
- `src/config.ts` — env-var-driven options (table names, bearer, TTL)
- `cloudformation/stack.json` — CloudFormation template (`nodejs24.x`, `arm64`)
- `custom_errors.policy.json` — handled-errors policy (defaults `emit_requestid_success: false`)

## Tables (already exist in `eu-west-1`, do NOT recreate)

- `DMLabelPrinterCloudDevices` — PK `DeviceCode` (S). Read-only here. We
  project the reserved-word attribute `Group` via `ProjectionExpression "#g"` +
  `ExpressionAttributeNames {"#g": "Group"}`.
- `DMLabelPrinterCloudPairingCodes` — PK `Code` (S). Other: `DeviceCode` (S),
  `StoreId` (S), `ExpiresAtUtc` (N, epoch seconds, TTL).
- `DMLabelPrinterCloudCustomerTokens` — PK `TokenHash` (S). Other: `StoreIds`
  (SS), `CreatedAtUtc` (S), `LastUsedAtUtc` (S).

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN` | only on the codes Lambda | `""` (auth disabled) | Cloud bearer accepted by the device-side endpoint. Empty disables auth. |
| `DM_LABEL_PRINTER_CLOUD_DEVICES_TABLE` | no | `DMLabelPrinterCloudDevices` | Devices table name. |
| `DM_LABEL_PRINTER_CLOUD_PAIRING_CODES_TABLE` | no | `DMLabelPrinterCloudPairingCodes` | Pairing-codes table name. |
| `DM_LABEL_PRINTER_CLOUD_CUSTOMER_TOKENS_TABLE` | no | `DMLabelPrinterCloudCustomerTokens` | Customer-tokens table name. |

The pairing-code TTL is fixed at 900 s (= 15 min) to match the .NET prototype.

## Build & test

```
npm ci
npm run build
npm test
```

The build emits `dist/`. The smoke tests assert the handlers can be imported,
pairing codes have the expected shape, the bearer mint has the expected
length/charset, and `redactDeep` redacts sensitive headers without dropping
the event schema.

## Deploy

This repo follows the team's `crp-repos-harden-deploy` skill / `lambda-upload`
canonical scripts:

- `npm run deploy:prod` — code-only deploy (default). Builds TS, then runs
  `lambda-upload deploy-prod dm`.
- `npm run deploy:prod:check` — local validation, no AWS calls; assumes
  `nodejs24.x` for the AWS SDK dependency policy check.
- `npm run deploy:prod:upgrade` — runtime + arch upgrade path. Builds TS, then
  runs `lambda-upload deploy-prod dm --upgrade-config` (runtime first, then
  code, then arch flips to `arm64`).

The CloudFormation template (`cloudformation/stack.json`) is parameterized so
each Function URL Lambda is deployed with its own
`HandlerEntrypoint` parameter:

- codes function: `dist/handlers/pairing-codes.handler`
- claim function: `dist/handlers/pairing-claim.handler`

Function URL configuration (`AuthType: NONE`, `InvokeMode: BUFFERED`) is
applied out-of-band via CRP / lambda-upload tooling.

## Handled errors

The handler emits `ACTION:SLACK_HANDLED_ERROR_HE1=<code>|<base64url(json)>` for
each policy-tracked failure. The repo-local `custom_errors.policy.json`
declares the codes used here:

- `customer_pairing_unauthorized`
- `customer_pairing_invalid_json_body`
- `customer_pairing_invalid_params`
- `customer_pairing_device_not_found`
- `customer_pairing_no_store_assignment`
- `customer_pairing_code_collision`
- `customer_pairing_code_not_found`
- `customer_pairing_code_expired`
- `customer_pairing_code_missing_store`

Defaults to `emit_requestid_success: false` (no legacy Slack suppression). See
[`dmngr/lambda-policies/handled-errors/handled-error-policy.md`](https://github.com/dmngr/lambda-policies/blob/main/handled-errors/handled-error-policy.md)
for the contract.

## Next steps (operator)

1. `crp repos harden-pr label-printer-cloud-customer-pairing`
2. After PR merges and you've reviewed it: `crp repos harden-deploy label-printer-cloud-customer-pairing --aws-profile dm --region eu-west-1`
