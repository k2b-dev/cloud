import { expect, setDefaultTimeout, setSystemTime } from "bun:test";
import { sql } from "bun";
import { Hono } from "hono";
import { findTargetHandler } from "hono/utils/handler";
import { SignJWT } from "jose";
import { type AuthContext, auth } from "../../packages/cloud/src/server/middleware/auth";
import { prepareIdentitySigner } from "../../packages/cloud/src/services/identity/key-ring";
import { getIdentityRuntimeConfig } from "../../packages/cloud/src/services/identity/runtime-config";
import { createTestSession } from "../../packages/cloud/src/services/session/session.test-fixture";

setDefaultTimeout(30_000);

/** Real signed credentials, verified against the test identity authority and live account. */
export async function withAdminOAuth(
  run: (fixture: {
    userId: string;
    oauthHeaders: (scope: string, audience?: string) => Promise<Record<string, string>>;
    readHeaders: Record<string, string>;
    writeHeaders: Record<string, string>;
    adminHeaders: Record<string, string>;
    sessionHeaders: Record<string, string>;
  }) => Promise<void>,
  options: { admin?: boolean } = {},
) {
  const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  setSystemTime(clock!.now);
  const [user] = await sql<{ id: string; auth_epoch: string }[]>`
    INSERT INTO auth.users(uid,provider,profile,admin)
    VALUES (${`admin-scope-${crypto.randomUUID()}`},'local','user',${options.admin ?? true}) RETURNING id,auth_epoch
  `;
  try {
    const signer = await prepareIdentitySigner("oauth");
    const { issuer } = await getIdentityRuntimeConfig();
    const token = (scope: string, audience = "cloud") =>
      new SignJWT({ token_use: "access", client_id: "cloud-cli", id: user!.id, auth_epoch: Number(user!.auth_epoch), scope })
        .setProtectedHeader({ alg: "RS256", kid: signer.kid, typ: "JWT" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(user!.id)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(signer.key);
    const oauthHeaders = async (scope: string, audience?: string) => ({ authorization: `Bearer ${await token(scope, audience)}` });
    const readHeaders = { authorization: `Bearer ${await token("read")}` };
    const writeHeaders = { authorization: `Bearer ${await token("write")}` };
    const adminHeaders = { authorization: `Bearer ${await token("admin")}` };
    const sessionHeaders = { cookie: `session_token=${await createTestSession(user!.id)}` };
    // A 403 on a mutation must be a scope rejection, not a broken token fixture.
    const probe = new Hono<AuthContext>().use(auth.requireRole("authenticated")).all("/", (c) => c.text("authorized"));
    expect((await probe.request("/", { headers: readHeaders })).status).toBe(200);
    for (const headers of [writeHeaders, adminHeaders, sessionHeaders]) {
      expect((await probe.request("/", { method: "POST", headers })).status).toBe(200);
    }
    await run({ userId: user!.id, oauthHeaders, readHeaders, writeHeaders, adminHeaders, sessionHeaders });
  } finally {
    await sql`DELETE FROM auth.users WHERE id=${user!.id}::uuid`;
    setSystemTime();
  }
}

type Router = {
  routes: readonly { method: string; path: string; handler: Hono["routes"][number]["handler"] }[];
  request: (request: Request) => Response | Promise<Response>;
};

/** Enumerate actual mounted routes, so new admin mutations join this regression automatically. */
export async function assertAdminMutationsRejectReadOAuth(
  router: Router,
  headers: Record<string, string>,
  include: (path: string) => boolean = () => true,
) {
  const readOnlyRoutes = new Set(
    router.routes.filter((route) => findTargetHandler(route.handler) === auth.readOnly).map(({ method, path }) => `${method} ${path}`),
  );
  const mutations = [
    ...new Map(
      router.routes
        .filter(
          ({ method, path }) =>
            ["POST", "PUT", "PATCH", "DELETE"].includes(method) && include(path) && !readOnlyRoutes.has(`${method} ${path}`),
        )
        .map((route) => [`${route.method} ${route.path}`, route]),
    ).values(),
  ];
  expect(mutations.length).toBeGreaterThan(0);
  for (const [index, { method, path }] of mutations.entries()) {
    const url = path.replace(/:[\w]+(?:\{[^}]+\})?/g, "11111111-1111-4111-8111-111111111111");
    // Independent synthetic gateway clients keep this route inventory from
    // exhausting one real Redis IP budget before authorization is reached.
    const response = await router.request(
      new Request(`http://localhost${url}`, {
        method,
        headers: { ...headers, "x-forwarded-for": `2001:db8:544:${index.toString(16)}::1` },
      }),
    );
    expect(response.status, `${method} ${path}`).toBe(403);
    expect(await response.json(), `${method} ${path}`).toMatchObject({ code: "FORBIDDEN" });
  }
}

/** A personal API key has no OAuth scope ceiling. */
export async function withPersonalApiKey(userId: string, run: (headers: Record<string, string>) => Promise<void>) {
  const { serviceAccountCredentials } = await import("../../packages/cloud/src/services/service-account-credentials");
  const [account] = await sql<{ id: string }[]>`
    INSERT INTO auth.service_accounts(name,kind,delegated_user_id)
    VALUES ('OAuth regression key','user_delegated',${userId}::uuid) RETURNING id
  `;
  try {
    const credential = await serviceAccountCredentials.createApiToken({
      serviceAccountId: account!.id,
      name: "Scope regression",
      scopes: [],
    });
    if (!credential.ok) throw new Error(credential.error.message);
    await run({ authorization: `Bearer ${credential.data.token}` });
  } finally {
    await sql`DELETE FROM auth.service_accounts WHERE id=${account!.id}::uuid`;
  }
}
