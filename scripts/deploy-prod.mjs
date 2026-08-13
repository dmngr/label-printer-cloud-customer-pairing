import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_ACCOUNT = "787324535455";
const EXPECTED_REGION = "eu-west-1";
const PARAMETER_NAME = "/dm/label-printer/cloud/shared-bearer-token";
const STATIC_TOKEN_KEY = "DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN";
const SSM_PARAMETER_KEY = "DM_LABEL_PRINTER_CLOUD_BEARER_TOKEN_SSM_PARAMETER";
const SHARED_ROLE_NAME = "lambda_dynamo_2";

const FUNCTIONS = [
  {
    name: "label-printer-cloud-customer-pairing-claim",
    handler: "dist/handlers/pairing-claim.handler",
    roleName: "label-printer-cloud-customer-pairing-claim-role",
    policyName: "label-printer-cloud-customer-pairing-claim-permissions",
    policyFile: "pairing-claim-execution-policy.json",
    canary: "claim",
  },
  {
    name: "label-printer-cloud-customer-pairing-codes",
    handler: "dist/handlers/pairing-codes.handler",
    roleName: "label-printer-cloud-customer-pairing-codes-role",
    policyName: "label-printer-cloud-customer-pairing-codes-permissions",
    policyFile: "pairing-codes-execution-policy.json",
    canary: "codes",
  },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const zipPath = path.join(os.homedir(), "localLambdas", `${packageJson.name}.zip`);
const trustPolicyPath = path.join(repoRoot, "infra", "lambda-assume-role-policy.json");
const profile = process.env.AWS_PROFILE?.trim() || "dm";
const region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || EXPECTED_REGION;
const checkOnly = process.argv.includes("--check");

function aws(args, { json = true } = {}) {
  const output = execFileSync(
    "aws",
    [...args, "--profile", profile, "--region", region, "--no-cli-pager", ...(json ? ["--output", "json"] : [])],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
  return json && output ? JSON.parse(output) : output;
}

function fileArgument(prefix, targetPath) {
  return `${prefix}${path.resolve(targetPath).replaceAll("\\", "/")}`;
}

function waitForUpdate(functionName) {
  aws(["lambda", "wait", "function-updated", "--function-name", functionName], { json: false });
}

function policyPath(target) {
  return path.join(repoRoot, "infra", target.policyFile);
}

function assertPolicyIsScoped(targetPath) {
  const policy = JSON.parse(fs.readFileSync(targetPath, "utf8"));
  for (const statement of policy.Statement ?? []) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    if (actions.some((action) => typeof action !== "string" || action.includes("*"))) {
      throw new Error(`Wildcard or invalid action in ${targetPath}`);
    }
    if (resources.some((resource) => resource === "*" || typeof resource !== "string")) {
      throw new Error(`Unscoped resource in ${targetPath}`);
    }
  }
}

function assertLocalInputs() {
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    throw new Error(`Deployment package not found or empty: ${zipPath}`);
  }
  if (packageJson.engines?.node !== ">=24") {
    throw new Error("package.json must require Node.js 24 or newer");
  }
  JSON.parse(fs.readFileSync(trustPolicyPath, "utf8"));
  for (const target of FUNCTIONS) assertPolicyIsScoped(policyPath(target));
}

function getRole(roleName) {
  try {
    return aws(["iam", "get-role", "--role-name", roleName]).Role;
  } catch (error) {
    const stderr = String(error?.stderr ?? "");
    if (stderr.includes("NoSuchEntity")) return null;
    throw error;
  }
}

function assertExclusiveAndUnmanaged(target, role) {
  const consumers = (aws(["lambda", "list-functions"]).Functions ?? [])
    .filter((fn) => fn.Role === role.Arn)
    .map((fn) => fn.FunctionName);
  const unexpectedConsumers = consumers.filter((name) => name !== target.name);
  if (unexpectedConsumers.length > 0) {
    throw new Error(`Refusing to modify role used by other Lambdas: ${unexpectedConsumers.join(", ")}`);
  }
  const attached = aws(["iam", "list-attached-role-policies", "--role-name", target.roleName]).AttachedPolicies ?? [];
  if (attached.length > 0) {
    throw new Error(`Unexpected managed policies on ${target.roleName}: ${attached.map((policy) => policy.PolicyName).join(", ")}`);
  }
  const inline = aws(["iam", "list-role-policies", "--role-name", target.roleName]).PolicyNames ?? [];
  const unexpectedInline = inline.filter((name) => name !== target.policyName);
  if (unexpectedInline.length > 0) {
    throw new Error(`Unexpected inline policies on ${target.roleName}: ${unexpectedInline.join(", ")}`);
  }
}

function ensureRole(target) {
  let role = getRole(target.roleName);
  if (!role) {
    aws([
      "iam",
      "create-role",
      "--role-name",
      target.roleName,
      "--description",
      `Least-privilege execution role for ${target.name}`,
      "--assume-role-policy-document",
      fileArgument("file://", trustPolicyPath),
      "--tags",
      "Key=ManagedBy,Value=label-printer-cloud-customer-pairing",
    ]);
    aws(["iam", "wait", "role-exists", "--role-name", target.roleName], { json: false });
    role = aws(["iam", "get-role", "--role-name", target.roleName]).Role;
  }

  assertExclusiveAndUnmanaged(target, role);
  aws(
    [
      "iam",
      "put-role-policy",
      "--role-name",
      target.roleName,
      "--policy-name",
      target.policyName,
      "--policy-document",
      fileArgument("file://", policyPath(target)),
    ],
    { json: false },
  );
  return role.Arn;
}

function writeEnvironment(tempDir, name, variables) {
  const outputPath = path.join(tempDir, name);
  fs.writeFileSync(outputPath, JSON.stringify({ Variables: variables }));
  return outputPath;
}

function updateConfiguration(target, args, attempts = 1) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      aws(["lambda", "update-function-configuration", "--function-name", target.name, ...args]);
      waitForUpdate(target.name);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
      }
    }
  }
  throw lastError;
}

function invokeCanary(target, tempDir) {
  const event =
    target.canary === "codes"
      ? {
          version: "2.0",
          rawPath: "/api/v1/pairing/codes",
          headers: { authorization: "Bearer deployment-canary-invalid" },
          body: JSON.stringify({ deviceCode: "DEPLOYMENT-CANARY-NOT-A-DEVICE" }),
          requestContext: {
            requestId: `deploy-canary-${Date.now()}`,
            http: { method: "POST", path: "/api/v1/pairing/codes", sourceIp: "127.0.0.1", userAgent: "pairing-deploy-canary" },
          },
          isBase64Encoded: false,
        }
      : {
          version: "2.0",
          rawPath: "/api/v1/pairing/claim",
          headers: {},
          body: JSON.stringify({ code: "000000" }),
          requestContext: {
            requestId: `deploy-canary-${Date.now()}`,
            http: { method: "POST", path: "/api/v1/pairing/claim", sourceIp: "127.0.0.1", userAgent: "pairing-deploy-canary" },
          },
          isBase64Encoded: false,
        };
  const expectedStatus = target.canary === "codes" ? 401 : 404;
  const responsePath = path.join(tempDir, `${target.name}-${Date.now()}.json`);
  const metadata = aws([
    "lambda",
    "invoke",
    "--function-name",
    target.name,
    "--cli-binary-format",
    "raw-in-base64-out",
    "--payload",
    JSON.stringify(event),
    responsePath,
  ]);
  if (metadata.FunctionError) throw new Error(`Canary invocation failed for ${target.name}: ${metadata.FunctionError}`);
  const response = JSON.parse(fs.readFileSync(responsePath, "utf8"));
  if (response.statusCode !== expectedStatus) {
    throw new Error(`Expected ${target.name} canary status ${expectedStatus}, received ${response.statusCode}`);
  }
}

assertLocalInputs();
if (checkOnly) {
  console.log(
    JSON.stringify({
      check: "ok",
      package: zipPath,
      version: packageJson.version,
      account: EXPECTED_ACCOUNT,
      region: EXPECTED_REGION,
      functions: FUNCTIONS.map(({ name, handler, roleName }) => ({ name, handler, roleName })),
    }),
  );
  process.exit(0);
}

if (region !== EXPECTED_REGION) {
  throw new Error(`Refusing deployment to ${region}; expected ${EXPECTED_REGION}`);
}
const identity = aws(["sts", "get-caller-identity"]);
if (identity.Account !== EXPECTED_ACCOUNT) {
  throw new Error(`Refusing deployment to AWS account ${identity.Account}; expected ${EXPECTED_ACCOUNT}`);
}
const parameter = aws(["ssm", "get-parameter", "--name", PARAMETER_NAME, "--query", "Parameter.{Name:Name,Type:Type}"]);
if (parameter.Name !== PARAMETER_NAME || parameter.Type !== "SecureString") {
  throw new Error(`Expected SecureString parameter ${PARAMETER_NAME}`);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "customer-pairing-deploy-"));
const backups = [];

try {
  const roleArns = new Map(FUNCTIONS.map((target) => [target.name, ensureRole(target)]));

  for (const target of FUNCTIONS) {
    const before = aws(["lambda", "get-function-configuration", "--function-name", target.name]);
    const previousRoleName = before.Role?.split("/").at(-1);
    if (![SHARED_ROLE_NAME, target.roleName].includes(previousRoleName)) {
      throw new Error(`Refusing to replace unexpected role ${previousRoleName} on ${target.name}`);
    }
    backups.push({ target, before });

    const variables = { ...(before.Environment?.Variables ?? {}) };
    delete variables[STATIC_TOKEN_KEY];
    if (target.canary === "codes") variables[SSM_PARAMETER_KEY] = PARAMETER_NAME;
    else delete variables[SSM_PARAMETER_KEY];
    const environmentPath = writeEnvironment(tempDir, `${target.name}-environment.json`, variables);

    updateConfiguration(
      target,
      [
        "--revision-id",
        before.RevisionId,
        "--role",
        roleArns.get(target.name),
        "--runtime",
        "nodejs24.x",
        "--handler",
        target.handler,
        "--environment",
        fileArgument("file://", environmentPath),
      ],
      6,
    );
    invokeCanary(target, tempDir);
  }

  const deployed = [];
  for (const target of FUNCTIONS) {
    aws([
      "lambda",
      "update-function-code",
      "--function-name",
      target.name,
      "--zip-file",
      fileArgument("fileb://", zipPath),
      "--architectures",
      "arm64",
    ]);
    waitForUpdate(target.name);
    invokeCanary(target, tempDir);

    const after = aws(["lambda", "get-function-configuration", "--function-name", target.name]);
    if (
      after.Role !== roleArns.get(target.name) ||
      after.Runtime !== "nodejs24.x" ||
      after.Architectures?.[0] !== "arm64" ||
      after.Handler !== target.handler
    ) {
      throw new Error(`Post-deploy configuration verification failed for ${target.name}`);
    }
    deployed.push({ name: target.name, role: target.roleName, codeSha256: after.CodeSha256 });
  }

  if (new Set(deployed.map(({ codeSha256 }) => codeSha256)).size !== 1) {
    throw new Error("The two pairing functions did not receive the same deployment package");
  }
  console.log(JSON.stringify({ deployed, account: identity.Account, region }));
} catch (error) {
  for (const { target, before } of backups.reverse()) {
    const rollbackEnvironmentPath = writeEnvironment(
      tempDir,
      `${target.name}-rollback-environment.json`,
      before.Environment?.Variables ?? {},
    );
    const current = aws(["lambda", "get-function-configuration", "--function-name", target.name]);
    updateConfiguration(target, [
      "--revision-id",
      current.RevisionId,
      "--role",
      before.Role,
      "--runtime",
      before.Runtime,
      "--handler",
      before.Handler,
      "--environment",
      fileArgument("file://", rollbackEnvironmentPath),
    ]);
  }
  throw error;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
