import assert from "node:assert/strict";
import { after, test } from "node:test";
import Module from "node:module";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { issueDeviceCredential, type DeviceCredential } from "../lib/device-credential";

const secret = "fixture-root-key-" + "x".repeat(40);
const identity: DeviceCredential = {
  version: 1,
  group: "group-a",
  storeCode: "store-a",
  installationId: "9cd89667-ae17-4b14-83bc-e7d342541349",
  deviceCode: "installation-9cd89667-ae17-4b14-83bc-e7d342541349",
  credentialId: "c282f93a-a56e-4778-938c-395356a0ad16",
};
const bearer = issueDeviceCredential(identity, secret);
type Command = { kind: string; input: Record<string, unknown> };
const calls: Command[] = [];
const conflict = false;
let deviceCode = identity.deviceCode;
let group = identity.group;
let storeCode = identity.storeCode;
let installationId = identity.installationId;
let missing = false;
let failure = false;
const sdk: Record<string, unknown> = {
  DynamoDBClient: class {
    async send(command: Command) {
      calls.push(command);
      if (failure) throw new Error("fixture transport failure");
      if (conflict && command.kind === "UpdateItemCommand")
        throw Object.assign(new Error("conditional refusal"), { name: "ConditionalCheckFailedException" });
      if (command.kind === "GetItemCommand") {
        if (missing) return {};
        if ((command.input.Key as Record<string, unknown>).Code) return {};
        return {
          Item: {
            DeviceCode: { S: deviceCode },
            Group: { S: group },
            StoreCode: { S: storeCode },
            InstallationId: { S: installationId },
            RequestedAtUtc: { S: "2026-10-10T10:00:00Z" },
          },
        };
      }
      return {};
    }
  },
};
for (const kind of ["UpdateItemCommand", "QueryCommand", "GetItemCommand", "PutItemCommand", "DeleteItemCommand", "TransactWriteItemsCommand"])
  sdk[kind] = class {
    kind = kind;
    constructor(public input: Record<string, unknown>) {}
  };
const ssm = {
  SSMClient: class {
    async send() {
      return { Parameter: { Value: secret } };
    }
  },
  GetParameterCommand: class {
    constructor(public input: object) {}
  },
};
const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const original = loader._load;
loader._load = function (name, ...args) {
  return name === "@aws-sdk/client-dynamodb" ? sdk : name === "@aws-sdk/client-ssm" ? ssm : original.call(this, name, ...args);
};
after(() => {
  loader._load = original;
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { handler } = require("../handlers/pairing-codes") as typeof import("../handlers/pairing-codes");
async function invoke(body: object, token = bearer, path = "/api/v1/pairing/codes") {
  const event = {
    version: "2.0",
    routeKey: "$default",
    rawQueryString: "",
    rawPath: path,
    headers: { authorization: "Bearer " + token },
    isBase64Encoded: false,
    requestContext: {
      accountId: "fixture",
      apiId: "fixture",
      domainName: "fixture",
      domainPrefix: "fixture",
      requestId: "fixture",
      routeKey: "$default",
      stage: "$default",
      time: "",
      timeEpoch: 0,
      http: { method: "POST", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "fixture" },
    },
    body: JSON.stringify(body),
  } as APIGatewayProxyEventV2;
  return (await handler(event, { awsRequestId: "device-scope-fixture" } as Context, () => undefined)) as { statusCode: number; body: string };
}
test("scoped pairing derives its device and grants only the persisted matching group", async () => {
  calls.length = 0;
  assert.equal((await invoke({})).statusCode, 201);
  const read = calls[0].input;
  assert.equal(read.ConsistentRead, true);
  assert.equal(read.ProjectionExpression, "DeviceCode, #g, StoreCode, InstallationId");
  const write = calls.find(c => c.kind === "PutItemCommand")!.input;
  assert.deepEqual((write.Item as Record<string, unknown>).StoreId, { S: identity.group });
  assert.deepEqual((write.Item as Record<string, unknown>).DeviceCode, { S: identity.deviceCode });
  calls.length = 0;
  assert.equal((await invoke({ deviceCode: "foreign" })).statusCode, 403);
  assert.equal(calls.length, 0);
});
test("persisted tenant/store/installation contradictions cannot mint a browser grant", async () => {
  for (const key of ["group", "storeCode", "installationId", "deviceCode"]) {
    if (key === "group") group = "foreign";
    if (key === "storeCode") storeCode = "foreign";
    if (key === "installationId") installationId = "foreign";
    if (key === "deviceCode") deviceCode = "foreign";
    calls.length = 0;
    assert.equal((await invoke({})).statusCode, 404, key);
    assert.equal(calls.length, 1, key);
    group = identity.group;
    storeCode = identity.storeCode;
    installationId = identity.installationId;
    deviceCode = identity.deviceCode;
  }
});
test("tampered credentials and transport errors never issue grants, legacy bearer keeps its scope", async () => {
  calls.length = 0;
  assert.equal((await invoke({}, bearer + "x")).statusCode, 401);
  assert.equal(calls.length, 0);
  failure = true;
  assert.equal((await invoke({})).statusCode, 500);
  failure = false;
  missing = true;
  assert.equal((await invoke({})).statusCode, 404);
  missing = false;
  deviceCode = "legacy";
  group = "legacy-group";
  calls.length = 0;
  assert.equal((await invoke({ deviceCode: "legacy" }, secret)).statusCode, 201);
  assert.equal(calls[0].input.ConsistentRead, undefined);
  assert.deepEqual((calls.find(c => c.kind === "PutItemCommand")!.input.Item as Record<string, unknown>).StoreId, { S: "legacy-group" });
  deviceCode = identity.deviceCode;
  group = identity.group;
});
