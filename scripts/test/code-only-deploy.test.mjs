import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createFrozenLambdaAws, deployCodeOnly } from "../code-only-deploy.mjs";

const account = "787324535455";
const targets = ["claim", "codes"].map(canary => ({
  name: `label-printer-cloud-customer-pairing-${canary}`,
  handler: `dist/handlers/pairing-${canary}.handler`,
  roleName: `label-printer-cloud-customer-pairing-${canary}-role`,
  canary,
}));
function configuration(target) {
  return {
    FunctionName: target.name,
    FunctionArn: `arn:aws:lambda:eu-west-1:${account}:function:${target.name}`,
    Runtime: "nodejs24.x",
    Architectures: ["arm64"],
    Handler: target.handler,
    Role: `arn:aws:iam::${account}:role/${target.roleName}`,
    State: "Active",
    LastUpdateStatus: "Successful",
    RevisionId: `before-${target.canary}`,
    CodeSha256: "old",
    CodeSize: 5,
    LastModified: "old",
    Environment: {
      Variables: {
        CUSTOMER_SETTING: "preserve",
        ...(target.canary === "codes"
          ? {
              DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN_SSM_PARAMETER: "/dm/label-printer/cloud/shared-bearer-token",
            }
          : {}),
      },
    },
    Timeout: 30,
    MemorySize: 128,
  };
}
function fixture(t, { beforeEdit = (_config, _target) => {}, afterEdit = (_config, _target) => {}, failUpload = false } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "pairing-code-only-test-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const zipPath = path.join(folder, "package.zip");
  fs.writeFileSync(zipPath, "test package");
  const hash = createHash("sha256").update("test package").digest("base64");
  const calls = [],
    updated = new Set();
  let identityChecks = 0;
  const aws = args => {
    calls.push(args);
    assert.equal(args[0], "lambda");
    const target = targets.find(value => value.name === args[args.indexOf("--function-name") + 1]);
    assert.ok(target);
    if (args[1] === "get-function-configuration") {
      const config = configuration(target);
      if (!updated.has(target.name)) beforeEdit?.(config, target);
      else {
        Object.assign(config, { CodeSha256: hash, RevisionId: "new", CodeSize: 12, LastModified: "new" });
        afterEdit?.(config, target);
      }
      return config;
    }
    if (args[1] === "update-function-code") {
      assert.equal(args[args.indexOf("--revision-id") + 1], `before-${target.canary}`);
      assert.deepEqual(args.slice(0, 2), ["lambda", "update-function-code"]);
      if (failUpload) throw new Error("revision conflict");
      updated.add(target.name);
      return {};
    }
    assert.deepEqual(args.slice(0, 3), ["lambda", "wait", "function-updated"]);
    return "";
  };
  aws.verifyIdentity = () => identityChecks++;
  return { run: () => deployCodeOnly({ aws, targets, zipPath }), calls, updated, identityChecks: () => identityChecks };
}

test("both exact functions receive one package with revision guards and no configuration writes", t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.configurationPreserved, true);
  assert.equal(result.deployed.length, 2);
  assert.equal(new Set(result.deployed.map(value => value.codeSha256)).size, 1);
  const writes = f.calls.filter(args => args[1] === "update-function-code");
  assert.equal(writes.length, 2);
  assert.ok(writes.every(args => args.length === 8 && !args.includes("--architectures")));
  assert.equal(f.identityChecks(), 1);
});

test("all targets are admitted before the first mutation", t => {
  const f = fixture(t, {
    beforeEdit: (config, target) => {
      if (target.canary === "codes") config.Environment.Variables.DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN = "legacy";
    },
  });
  assert.throws(f.run, /preflight failed/);
  assert.equal(f.updated.size, 0);
});

test("read-back rejects preserved-setting drift and does not update the second function", t => {
  const f = fixture(t, {
    afterEdit: config => {
      delete config.Environment.Variables.CUSTOMER_SETTING;
    },
  });
  assert.throws(f.run, /read-back failed/);
  assert.equal(f.updated.size, 1);
});

test("a concurrent revision failure stops without retry or configuration rollback", t => {
  const f = fixture(t, { failUpload: true });
  assert.throws(f.run, /revision conflict/);
  assert.equal(f.calls.filter(args => args[1] === "update-function-code").length, 1);
  assert.equal(f.updated.size, 0);
});

test("profile credentials resolve once and every mutation rechecks the frozen identity", () => {
  const calls = [];
  const run = (_exe, args, options) => {
    calls.push({ args, env: { ...options.env } });
    if (args[0] === "configure") return JSON.stringify({ AccessKeyId: "test-key", SecretAccessKey: "test-secret", SessionToken: "test-session" });
    assert.ok(!args.includes("--profile"));
    assert.equal(options.env.AWS_SESSION_TOKEN, "test-session");
    assert.equal(options.env.AWS_SECRET_ACCESS_KEY, "test-secret");
    assert.equal(args[args.indexOf("--endpoint-url") + 1], `https://${args[0]}.eu-west-1.amazonaws.com`);
    return JSON.stringify(args[0] === "sts" ? { Account: account } : {});
  };
  const aws = createFrozenLambdaAws({ run, environment: { AWS_PROFILE: "dm", AWS_REGION: "eu-west-1" } });
  aws(["lambda", "get-function-configuration", "--function-name", targets[0].name]);
  aws(["lambda", "update-function-code", "--function-name", targets[0].name]);
  aws.verifyIdentity();
  assert.equal(calls.filter(value => value.args[0] === "configure").length, 1);
  assert.equal(calls.filter(value => value.args[0] === "sts").length, 3);
  assert.throws(() => aws(["lambda", "get-function", "--profile=other"]), /child selector/);
  assert.throws(() => aws(["iam", "get-role"]), /service/);
});

test("ambiguous selectors and a wrong account refuse before writes", () => {
  let calls = 0;
  assert.throws(
    () =>
      createFrozenLambdaAws({
        environment: { AWS_ENDPOINT_URL: "https://wrong.invalid" },
        run: () => {
          calls++;
          return "";
        },
      }),
    /Ambiguous/,
  );
  assert.equal(calls, 0);
  assert.throws(
    () =>
      createFrozenLambdaAws({
        environment: {},
        run: (_exe, args) => {
          calls++;
          return JSON.stringify(args[0] === "configure" ? { AccessKeyId: "test", SecretAccessKey: "test" } : { Account: "000000000000" });
        },
      }),
    /Unexpected AWS account/,
  );
  assert.equal(calls, 2);
});

test("provider failures never expose their output", () => {
  for (const run of [
    () => "SECRET invalid json",
    () => {
      throw new Error("SECRET provider output");
    },
  ]) {
    assert.throws(
      () => createFrozenLambdaAws({ environment: {}, run }),
      error => !String(error).includes("SECRET"),
    );
  }
});
