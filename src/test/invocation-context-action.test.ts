import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildInvocationContextAction } from "../lib/invocation-context-action.js";

test("invocation context action marker is canonical and decodable", () => {
  const context = {
    log_type: "ctx",
    handler: "policyTest",
    awsRequestId: "request-123"
  };
  const marker = buildInvocationContextAction(context);
  const prefix = "ACTION:SLACK_CTX_V1=";

  assert.ok(marker.startsWith(prefix));
  const decoded = JSON.parse(
    Buffer.from(marker.slice(prefix.length), "base64url").toString("utf8")
  ) as Record<string, unknown>;
  assert.deepEqual(decoded, { v: 1, ...context });
});
