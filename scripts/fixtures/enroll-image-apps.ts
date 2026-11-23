/** Run inside an ephemeral Core container. Redirect stdout to a private file. */
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: bun enroll-image-apps.ts <app-id>... [--oauth-issuer <app-id>]\nEnroll fresh image-smoke identities through Core. Requires ADMIN_LOGIN_TOKEN and APP_URL. Outputs private keys as JSON; redirect to a protected file.",
  );
  process.exit(0);
}
const grantAt = args.indexOf("--oauth-issuer");
const oauthIssuer = grantAt < 0 ? undefined : args[grantAt + 1];
if (grantAt >= 0) args.splice(grantAt, 2);
if (
  !args.length ||
  args.some((id) => !/^[a-z][a-z0-9-]{0,79}$/.test(id) || ["core", "gateway"].includes(id)) ||
  (grantAt >= 0 && !args.includes(oauthIssuer ?? ""))
)
  throw new Error("Use --help for valid app IDs and grant options");
const token = process.env.ADMIN_LOGIN_TOKEN;
const origin = process.env.APP_URL;
if (!token || !origin) throw new Error("Ephemeral Core requires ADMIN_LOGIN_TOKEN and APP_URL");
const core = "http://127.0.0.1:3000";
const deadline = Date.now() + 180_000;
while (true) {
  try {
    const ready = await fetch(`${core}/_cloud/ready`, { signal: AbortSignal.timeout(2_000) });
    await ready.body?.cancel();
    if (ready.ok) break;
  } catch {
    /* Core is still starting. */
  }
  if (Date.now() >= deadline) throw new Error("Ephemeral Core did not become ready");
  await Bun.sleep(1_000);
}
const login = await fetch(`${core}/api/auth/admin-login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ token }),
  signal: AbortSignal.timeout(10_000),
});
if (!login.ok) throw new Error(`Ephemeral admin login failed (${login.status})`);
const session: unknown = await login.json();
if (!session || typeof session !== "object" || !("session_token" in session) || typeof session.session_token !== "string")
  throw new Error("Ephemeral login returned no session");
const authorization = `Bearer ${session.session_token}`;
const continuation = await fetch(`${core}/auth/continue`, {
  headers: { cookie: `session_token=${session.session_token}` },
  signal: AbortSignal.timeout(10_000),
});
const version = /data-legal-version="([a-f0-9]{64})"/.exec(await continuation.text())?.[1];
if (version) {
  const consent = await fetch(`${core}/api/auth/legal-consent`, {
    method: "POST",
    headers: { authorization, origin, "content-type": "application/json" },
    body: JSON.stringify({ accepted: true, version }),
    signal: AbortSignal.timeout(10_000),
  });
  await consent.body?.cancel();
  if (!consent.ok) throw new Error(`Ephemeral legal consent failed (${consent.status})`);
}
const keys: Record<string, string> = {};
for (const appId of new Set(args)) {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!privateKey.d || !publicKey.x) throw new Error("Ed25519 key export failed");
  const response = await fetch(`${core}/api/admin/apps/${appId}/keys`, {
    method: "POST",
    headers: { authorization, origin, "content-type": "application/json" },
    body: JSON.stringify({ publicKey: publicKey.x, grants: appId === oauthIssuer ? ["oauth:issue"] : [] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Ephemeral ${appId} enrollment failed (${response.status})`);
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("installationId" in result) ||
    !("keyId" in result) ||
    typeof result.installationId !== "string" ||
    typeof result.keyId !== "string"
  )
    throw new Error("Invalid enrollment coordinates");
  keys[appId] = `cloud-app-key-v1.${result.installationId}.${appId}.${result.keyId}.${privateKey.d}`;
}
console.log(JSON.stringify(keys));

export {};
