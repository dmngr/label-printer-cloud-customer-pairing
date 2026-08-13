# label-printer-cloud-customer-pairing

Customer-pairing Lambdas for the DM Label Printer customer web app at
[app.label.ninja](https://app.label.ninja). One reviewed Node.js 24 TypeScript
bundle supplies two Lambda Function URL handlers:

| Endpoint                | Method | Side   | Authentication                                |
| ----------------------- | ------ | ------ | --------------------------------------------- |
| `/api/v1/pairing/codes` | POST   | device | Shared bearer loaded from DM AWS SSM          |
| `/api/v1/pairing/claim` | POST   | web    | Optional customer bearer used to merge stores |

Both live functions run in DM account `787324535455`, region `eu-west-1`, on
`nodejs24.x` and `arm64`. No .NET runtime or .NET deployment artifact is used.

## Layout

- `src/handlers/pairing-codes.ts`: device-side handler.
- `src/handlers/pairing-claim.ts`: web-side handler.
- `src/storage/dynamo-store.ts`: DynamoDB persistence.
- `src/lib/bearer-authorizer.ts`: SSM-backed shared bearer authorization.
- `src/lib/customer-token.ts`: customer bearer generation and hashing.
- `infra/pairing-codes-execution-policy.json`: exact SSM, Devices,
  PairingCodes, and log permissions.
- `infra/pairing-claim-execution-policy.json`: exact PairingCodes,
  CustomerTokens, and log permissions.
- `scripts/deploy-prod.mjs`: account-gated dual-function deployment.
- `cloudformation/stack.json`: Node.js 24 ARM64 infrastructure contract.

## DynamoDB

The following existing `eu-west-1` tables are used and must not be recreated:

- `DMLabelPrinterCloudDevices`, partition key `DeviceCode` (S).
- `DMLabelPrinterCloudPairingCodes`, partition key `Code` (S), TTL
  `ExpiresAtUtc` (N).
- `DMLabelPrinterCloudCustomerTokens`, partition key `TokenHash` (S).

All Label Printer tables use DynamoDB on-demand billing (`PAY_PER_REQUEST`).
The pairing-code TTL is fixed at 900 seconds to preserve the API contract.

## Configuration

| Variable                                            | Default                                       | Notes                                                                                   |
| --------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN_SSM_PARAMETER` | `/dm/label-printer/cloud/shared-bearer-token` | SecureString parameter name; the token is never stored in Lambda environment variables. |
| `DM_LABEL_PRINTER_CLOUD_DEVICES_TABLE`              | `DMLabelPrinterCloudDevices`                  | Devices table.                                                                          |
| `DM_LABEL_PRINTER_CLOUD_PAIRING_CODES_TABLE`        | `DMLabelPrinterCloudPairingCodes`             | Pairing-code table.                                                                     |
| `DM_LABEL_PRINTER_CLOUD_CUSTOMER_TOKENS_TABLE`      | `DMLabelPrinterCloudCustomerTokens`           | Customer-token table.                                                                   |

## Build And Test

```powershell
npm ci
npm run lint:check
npm run format:check
npm run typecheck
npm test
npm run deploy:prod:check
```

## Hardened Deploy

Deployments must run through the `crp-repos-harden-deploy` workflow. The repo
contains two handlers, so `npm run deploy:prod` deliberately performs a
dual-function deployment instead of deriving one Lambda name from
`package.json.name`.

The deployment process:

1. Builds and packages one reviewed bundle without changing its committed version.
2. Refuses any AWS account other than `787324535455` or region other than `eu-west-1`.
3. Verifies that the shared bearer parameter exists as a SecureString.
4. Creates or verifies separate `pairing-codes` and `pairing-claim` execution
   roles; it never modifies `lambda_dynamo_2`.
5. Rejects a dedicated role if another Lambda consumes it or it has an
   unexpected managed or inline policy.
6. Switches each function independently and runs non-writing SSM/DynamoDB
   canaries; any failure restores both previous roles and environments.
7. Uploads the same ZIP to `label-printer-cloud-customer-pairing-claim` and
   `label-printer-cloud-customer-pairing-codes`.
8. Enforces `nodejs24.x`, `arm64`, and each exact Node handler.
9. Removes `DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN`; only the codes handler keeps
   the SSM parameter name because the claim handler does not read that secret.
10. Reads back both configurations and requires an identical `CodeSha256`.

The handlers use these entries:

- `dist/handlers/pairing-codes.handler`
- `dist/handlers/pairing-claim.handler`

## Handled Errors

`custom_errors.policy.json` covers validation, pairing state, authorization, and
SSM authorization-configuration failures. Known failures emit the canonical
`ACTION:SLACK_HANDLED_ERROR_HE1=` marker. Unexpected failures emit
`RequestId FAILED`; successful requests emit `RequestId SUCCESS`.
