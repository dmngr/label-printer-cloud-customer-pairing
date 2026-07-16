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
const POLICY_NAME = "label-printer-cloud-customer-pairing-ssm-access";
const FUNCTIONS = [
  {
    name: "label-printer-cloud-customer-pairing-claim",
    handler: "dist/handlers/pairing-claim.handler",
  },
  {
    name: "label-printer-cloud-customer-pairing-codes",
    handler: "dist/handlers/pairing-codes.handler",
  },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const zipPath = path.join(os.homedir(), "localLambdas", `${packageJson.name}.zip`);
const profile = process.env.AWS_PROFILE?.trim() || "dm";
const region = process.env.AWS_REGION?.trim() || process.env.AWS_DEFAULT_REGION?.trim() || EXPECTED_REGION;
const checkOnly = process.argv.includes("--check");

function aws(args, { json = true } = {}) {
  const output = execFileSync("aws", [...args, "--profile", profile, "--region", region, ...(json ? ["--output", "json"] : [])], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  return json && output ? JSON.parse(output) : output;
}

function fileArgument(prefix, targetPath) {
  return `${prefix}${path.resolve(targetPath).replaceAll("\\", "/")}`;
}

function waitForUpdate(functionName) {
  aws(["lambda", "wait", "function-updated", "--function-name", functionName], {
    json: false,
  });
}

function assertLocalPackage() {
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    throw new Error(`Deployment package not found or empty: ${zipPath}`);
  }
  if (packageJson.engines?.node !== ">=24") {
    throw new Error("package.json must require Node.js 24 or newer");
  }
}

assertLocalPackage();
if (checkOnly) {
  console.log(
    JSON.stringify({
      check: "ok",
      package: zipPath,
      version: packageJson.version,
      account: EXPECTED_ACCOUNT,
      region: EXPECTED_REGION,
      functions: FUNCTIONS.map(({ name, handler }) => ({ name, handler })),
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
const policyPath = path.join(repoRoot, "infra", "customer-pairing-ssm-policy.json");
const roleNames = new Set();

try {
  for (const target of FUNCTIONS) {
    const configuration = aws(["lambda", "get-function-configuration", "--function-name", target.name]);
    const roleName = configuration.Role?.split("/").at(-1);
    if (!roleName) throw new Error(`Execution role missing for ${target.name}`);
    roleNames.add(roleName);
  }

  for (const roleName of roleNames) {
    aws(["iam", "put-role-policy", "--role-name", roleName, "--policy-name", POLICY_NAME, "--policy-document", fileArgument("file://", policyPath)], {
      json: false,
    });
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

    const before = aws(["lambda", "get-function-configuration", "--function-name", target.name]);
    const variables = { ...(before.Environment?.Variables || {}) };
    delete variables[STATIC_TOKEN_KEY];
    variables[SSM_PARAMETER_KEY] = PARAMETER_NAME;
    const environmentPath = path.join(tempDir, `${target.name}-environment.json`);
    fs.writeFileSync(environmentPath, JSON.stringify({ Variables: variables }));

    aws([
      "lambda",
      "update-function-configuration",
      "--function-name",
      target.name,
      "--runtime",
      "nodejs24.x",
      "--handler",
      target.handler,
      "--environment",
      fileArgument("file://", environmentPath),
    ]);
    waitForUpdate(target.name);

    const after = aws(["lambda", "get-function-configuration", "--function-name", target.name]);
    const afterVariables = after.Environment?.Variables || {};
    if (
      after.Runtime !== "nodejs24.x" ||
      after.Architectures?.[0] !== "arm64" ||
      after.Handler !== target.handler ||
      STATIC_TOKEN_KEY in afterVariables ||
      afterVariables[SSM_PARAMETER_KEY] !== PARAMETER_NAME
    ) {
      throw new Error(`Post-deploy configuration verification failed for ${target.name}`);
    }
    deployed.push({
      name: target.name,
      runtime: after.Runtime,
      architecture: after.Architectures[0],
      handler: after.Handler,
      codeSha256: after.CodeSha256,
    });
  }

  if (new Set(deployed.map(({ codeSha256 }) => codeSha256)).size !== 1) {
    throw new Error("The two pairing functions did not receive the same deployment package");
  }
  console.log(JSON.stringify({ deployed, account: identity.Account, region }));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
