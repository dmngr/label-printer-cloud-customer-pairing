/**
 * DynamoDB store, ported from `Storage/DynamoCustomerPairingStore.cs`.
 *
 * Uses the low-level `@aws-sdk/client-dynamodb` (AttributeValue shapes) so the
 * port stays line-for-line equivalent to the C# version, including the
 * `ProjectionExpression "#g"` workaround for the reserved word `Group` and
 * the `ADD ... SET LastUsedAtUtc` UpdateExpression on the customer-tokens
 * table.
 *
 * Note (Phase 4 AWS SDK hygiene): on Node 18+ managed runtimes, `@aws-sdk/*`
 * packages are runtime-included. We therefore intentionally do **not** pin
 * them in `package.json` (no `dependencies` block in this repo), and we
 * import them at runtime only.
 */

import type { CustomerPairingOptions } from "../config";
import type { CustomerTokenRecord, PairingCodeRecord } from "../types";

// AWS SDK v3 is runtime-included on Node 18+ Lambda runtimes (Phase 4 hygiene:
// nothing pinned in `package.json`). We require it at runtime and declare just
// enough of the surface area to keep the rest of this file strictly typed.

interface AttributeValue {
  S?: string;
  N?: string;
  SS?: string[];
}

interface GetItemInput {
  TableName: string;
  Key: Record<string, AttributeValue>;
  ProjectionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
}

interface GetItemOutput {
  Item?: Record<string, AttributeValue>;
}

interface PutItemInput {
  TableName: string;
  Item: Record<string, AttributeValue>;
}

interface DeleteItemInput {
  TableName: string;
  Key: Record<string, AttributeValue>;
}

interface UpdateItemInput {
  TableName: string;
  Key: Record<string, AttributeValue>;
  UpdateExpression: string;
  ExpressionAttributeValues: Record<string, AttributeValue>;
  ReturnValues?: "ALL_NEW" | "NONE";
}

interface UpdateItemOutput {
  Attributes?: Record<string, AttributeValue>;
}

interface DynamoCommand<TInput, TOutput> {
  readonly input: TInput;
  readonly __out__?: TOutput;
}

interface DynamoCommandCtor<TInput, TOutput> {
  new (input: TInput): DynamoCommand<TInput, TOutput>;
}

interface DynamoClient {
  send<TInput, TOutput>(command: DynamoCommand<TInput, TOutput>): Promise<TOutput>;
}

interface DynamoSdkModule {
  DynamoDBClient: new (cfg: Record<string, unknown>) => DynamoClient;
  GetItemCommand: DynamoCommandCtor<GetItemInput, GetItemOutput>;
  PutItemCommand: DynamoCommandCtor<PutItemInput, unknown>;
  DeleteItemCommand: DynamoCommandCtor<DeleteItemInput, unknown>;
  UpdateItemCommand: DynamoCommandCtor<UpdateItemInput, UpdateItemOutput>;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sdk: DynamoSdkModule = require("@aws-sdk/client-dynamodb") as DynamoSdkModule;
const { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, UpdateItemCommand } = sdk;

/**
 * Module-scoped client so successive invocations on a warm container reuse
 * the underlying connection pool. Constructor reads region from env
 * (`AWS_REGION` is set automatically by Lambda).
 */
const dynamoClient = new DynamoDBClient({});

function s(value: string | null | undefined): AttributeValue {
  return { S: typeof value === "string" ? value : "" };
}

function n(value: number): AttributeValue {
  return { N: String(value) };
}

function readString(item: Record<string, AttributeValue> | undefined, key: string): string {
  if (!item) return "";
  const attr = item[key];
  return attr && typeof attr.S === "string" ? attr.S : "";
}

export class DynamoCustomerPairingStore {
  constructor(private readonly options: CustomerPairingOptions) {}

  async getDeviceGroup(deviceCode: string): Promise<string | null> {
    const response = await dynamoClient.send(
      new GetItemCommand({
        TableName: this.options.devicesTableName,
        Key: { DeviceCode: s(deviceCode) },
        // Project the key too: with ProjectionExpression="#g" alone, DynamoDB
        // returns Item={} when the device exists but has no Group attribute,
        // which is indistinguishable from a missing device and would cause
        // the handler to 404 a real device that just hasn't been assigned a
        // Group yet. Including the key gives us a non-empty Item for existing
        // devices regardless of Group, so we can correctly map missing-Group
        // to the 409 "no store assignment" path.
        ProjectionExpression: "DeviceCode, #g",
        ExpressionAttributeNames: { "#g": "Group" }
      })
    );

    const item = response.Item;
    if (!item || Object.keys(item).length === 0) return null;

    const groupAttr = item["Group"];
    const groupValue = groupAttr && typeof groupAttr.S === "string" ? groupAttr.S : "";
    if (groupValue.trim().length === 0) {
      // Device exists but has no Group / empty Group -> caller treats as 409.
      return "";
    }
    return groupValue;
  }

  async putPairingCode(record: PairingCodeRecord): Promise<void> {
    await dynamoClient.send(
      new PutItemCommand({
        TableName: this.options.pairingCodesTableName,
        Item: {
          Code: s(record.code),
          DeviceCode: s(record.deviceCode),
          StoreId: s(record.storeId),
          ExpiresAtUtc: n(record.expiresAtUtc)
        }
      })
    );
  }

  async getPairingCode(code: string): Promise<PairingCodeRecord | null> {
    const response = await dynamoClient.send(
      new GetItemCommand({
        TableName: this.options.pairingCodesTableName,
        Key: { Code: s(code) }
      })
    );

    const item = response.Item;
    if (!item || Object.keys(item).length === 0) return null;

    let expiresAtUtc = 0;
    const ttlAttr = item["ExpiresAtUtc"];
    if (ttlAttr && typeof ttlAttr.N === "string") {
      const parsed = Number.parseInt(ttlAttr.N, 10);
      if (Number.isFinite(parsed)) expiresAtUtc = parsed;
    }

    return {
      code: readString(item, "Code"),
      deviceCode: readString(item, "DeviceCode"),
      storeId: readString(item, "StoreId"),
      expiresAtUtc
    };
  }

  async deletePairingCode(code: string): Promise<void> {
    await dynamoClient.send(
      new DeleteItemCommand({
        TableName: this.options.pairingCodesTableName,
        Key: { Code: s(code) }
      })
    );
  }

  async getCustomerToken(tokenHash: string): Promise<CustomerTokenRecord | null> {
    const response = await dynamoClient.send(
      new GetItemCommand({
        TableName: this.options.customerTokensTableName,
        Key: { TokenHash: s(tokenHash) }
      })
    );

    const item = response.Item;
    if (!item || Object.keys(item).length === 0) return null;

    const storeIdsAttr = item["StoreIds"];
    const storeIds =
      storeIdsAttr && Array.isArray(storeIdsAttr.SS) ? [...storeIdsAttr.SS] : [];

    return {
      tokenHash: readString(item, "TokenHash"),
      storeIds,
      createdAtUtc: readString(item, "CreatedAtUtc"),
      lastUsedAtUtc: readString(item, "LastUsedAtUtc")
    };
  }

  async putCustomerToken(record: CustomerTokenRecord): Promise<void> {
    const item: Record<string, AttributeValue> = {
      TokenHash: s(record.tokenHash),
      CreatedAtUtc: s(record.createdAtUtc),
      LastUsedAtUtc: s(record.lastUsedAtUtc)
    };

    if (record.storeIds.length > 0) {
      item["StoreIds"] = { SS: [...record.storeIds] };
    }

    await dynamoClient.send(
      new PutItemCommand({
        TableName: this.options.customerTokensTableName,
        Item: item
      })
    );
  }

  async appendStoreToCustomerToken(
    tokenHash: string,
    storeId: string,
    nowIso: string
  ): Promise<string[]> {
    // ADD on a String Set deduplicates members automatically; SET LastUsedAtUtc
    // updates the activity timestamp in the same call. Mirrors the C# version.
    const response = await dynamoClient.send(
      new UpdateItemCommand({
        TableName: this.options.customerTokensTableName,
        Key: { TokenHash: s(tokenHash) },
        UpdateExpression: "ADD StoreIds :storeId SET LastUsedAtUtc = :now",
        ExpressionAttributeValues: {
          ":storeId": { SS: [storeId] },
          ":now": s(nowIso)
        },
        ReturnValues: "ALL_NEW"
      })
    );

    const attrs = response.Attributes;
    const storeIdsAttr = attrs?.["StoreIds"];
    if (storeIdsAttr && Array.isArray(storeIdsAttr.SS)) {
      return [...storeIdsAttr.SS];
    }
    return [storeId];
  }
}
