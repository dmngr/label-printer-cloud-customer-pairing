/** Updates the two existing pairing functions without changing IAM, configuration,
 * browser grants or credentials. The release operator holds the exact-target
 * receipt/lock; RevisionId also prevents racing a deployment from another host.
 * AWS credentials are resolved once from the developer's dm profile and remain
 * in memory. Child CLI calls cannot select a different profile or endpoint.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

const ACCOUNT = "787324535455";
const REGION = "eu-west-1";
const PARAMETER = "/dm/label-printer/cloud/shared-bearer-token";
const PARAMETER_KEY = "DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN_SSM_PARAMETER";
const STATIC_KEY = "DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN";

export function createFrozenLambdaAws({
  environment = process.env,
  run = (file, args, options) => execFileSync(file, args, { ...options, encoding: "utf8" }),
} = {}) {
  for (const [key, value] of Object.entries(environment)) {
    if (!key.startsWith("AWS_") || !value) continue;
    if (key === "AWS_PROFILE" && value === "dm") continue;
    if (["AWS_REGION", "AWS_DEFAULT_REGION"].includes(key) && value === REGION) continue;
    if (key === "AWS_PAGER") continue;
    throw new Error("Ambiguous AWS credential or endpoint selector");
  }
  const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("AWS_")));
  Object.assign(env, {
    AWS_CONFIG_FILE: path.join(os.homedir(), ".aws", "config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(os.homedir(), ".aws", "credentials"),
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
  });
  const execute = args => {
    try {
      return run("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env, timeout: 120000 }).trim();
    } catch {
      // CLI errors can contain a credential_process response or environment values.
      throw new Error(`AWS CLI failed during ${args[0]} ${args[1]}`);
    }
  };
  let resolved;
  try {
    resolved = JSON.parse(execute(["configure", "export-credentials", "--profile", "dm", "--format", "process"]));
  } catch {
    throw new Error("Profile credentials could not be resolved");
  }
  if (!resolved.AccessKeyId || !resolved.SecretAccessKey) throw new Error("Profile credentials were not resolved");
  env.AWS_ACCESS_KEY_ID = resolved.AccessKeyId;
  env.AWS_SECRET_ACCESS_KEY = resolved.SecretAccessKey;
  if (resolved.SessionToken) env.AWS_SESSION_TOKEN = resolved.SessionToken;
  const invoke = (args, { json = true } = {}) => {
    if (!["sts", "lambda"].includes(args[0]) || args.some(arg => /^--(?:profile|endpoint-url|region)(?:=|$)/.test(arg)))
      throw new Error("Unexpected AWS service or child selector");
    const output = execute([
      ...args,
      "--region",
      REGION,
      "--endpoint-url",
      `https://${args[0]}.${REGION}.amazonaws.com`,
      "--no-cli-pager",
      ...(json ? ["--output", "json"] : []),
    ]);
    return json && output ? JSON.parse(output) : output;
  };
  const verifyIdentity = () => {
    if (invoke(["sts", "get-caller-identity"]).Account !== ACCOUNT) throw new Error("Unexpected AWS account");
  };
  verifyIdentity();
  const aws = (args, options) => {
    if (args[1] === "update-function-code") verifyIdentity();
    return invoke(args, options);
  };
  aws.verifyIdentity = verifyIdentity;
  return aws;
}

function configuration(config) {
  const changing = new Set([
    "CodeSha256",
    "CodeSize",
    "LastModified",
    "RevisionId",
    "LastUpdateStatus",
    "LastUpdateStatusReason",
    "LastUpdateStatusReasonCode",
  ]);
  return Object.fromEntries(Object.entries(config).filter(([key]) => !changing.has(key)));
}

export function deployCodeOnly({ aws, targets, zipPath }) {
  const expectedHash = createHash("sha256").update(fs.readFileSync(zipPath)).digest("base64");
  const snapshots = targets.map(target => {
    const before = aws(["lambda", "get-function-configuration", "--function-name", target.name]);
    const variables = before.Environment?.Variables ?? {};
    if (
      before.FunctionArn !== `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${target.name}` ||
      before.State !== "Active" ||
      before.LastUpdateStatus !== "Successful" ||
      before.Runtime !== "nodejs24.x" ||
      before.Architectures?.length !== 1 ||
      before.Architectures[0] !== "arm64" ||
      before.Handler !== target.handler ||
      before.Role !== `arn:aws:iam::${ACCOUNT}:role/${target.roleName}` ||
      !before.RevisionId ||
      Object.hasOwn(variables, STATIC_KEY) ||
      (target.canary === "codes" ? variables[PARAMETER_KEY] !== PARAMETER : Object.hasOwn(variables, PARAMETER_KEY))
    )
      throw new Error(`Code-only preflight failed for ${target.name}`);
    return { target, before };
  });
  const deployed = [];
  for (const { target, before } of snapshots) {
    aws([
      "lambda",
      "update-function-code",
      "--function-name",
      target.name,
      "--revision-id",
      before.RevisionId,
      "--zip-file",
      `fileb://${path.resolve(zipPath).replaceAll("\\", "/")}`,
    ]);
    aws(["lambda", "wait", "function-updated", "--function-name", target.name], { json: false });
    const after = aws(["lambda", "get-function-configuration", "--function-name", target.name]);
    if (
      after.CodeSha256 !== expectedHash ||
      after.LastUpdateStatus !== "Successful" ||
      !isDeepStrictEqual(configuration(after), configuration(before))
    )
      throw new Error(`Code-only read-back failed for ${target.name}`);
    deployed.push({ name: target.name, codeSha256: after.CodeSha256 });
  }
  aws.verifyIdentity();
  return { deployed, account: ACCOUNT, region: REGION, configurationPreserved: true };
}
