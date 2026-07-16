export function buildInvocationContextAction(context: object): string {
  const payload = JSON.stringify({ v: 1, ...context });
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  return `ACTION:SLACK_CTX_V1=${encoded}`;
}
