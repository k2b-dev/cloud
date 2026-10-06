import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { get, oauthTokens, set } from "@k2b/cloud/services";
import { invalidateIdentityRuntimeConfig } from "@k2b/cloud/services/identity/runtime-config";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import * as cloudSsr from "@k2b/cloud/ssr";
import { createConfig } from "@k2b/ssr";
import { LocaleProvider } from "@k2b/ui";
import { type Server, sql } from "bun";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { uniqueCallerAddress } from "../../../scripts/fixtures/caller-address";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { launchBrowser } from "../../ui/test/browser";

// A person approves or denies an MCP client in a real browser: dynamic registration, authorization,
// the consent page with its real headers and form, the loopback callback, and the code exchange.
// Requests that a test builds by hand cannot show which Origin a browser sends for the consent form.
const suite = suiteFor("database", "valkey", "nats");

const VERIFIER = "consent-browser-verifier-0123456789-abcdefghijk";

const pkceChallenge = async () =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(VERIFIER))).toBase64({
    alphabet: "base64url",
    omitPadding: true,
  });

suite("OAuth consent in a browser", () => {
  const root = mkdtempSync(join(tmpdir(), "oauth-consent-browser-"));
  const spies: Array<{ mockRestore(): void }> = [];
  const consentOrigins: string[] = [];
  const clientIds: string[] = [];
  let browser: Browser;
  let server: Server<unknown>;
  let listener: Server<unknown>;
  let origin: string;
  // Claude Code and other native clients register the exact callback of their own loopback listener (RFC 8252).
  let callbackUri: string;
  let previousAppUrl: unknown;
  let userId: string;
  let sessionToken: string;

  beforeAll(async () => {
    const { plugin } = createConfig({ dev: true, rootDir: root });
    Bun.plugin(plugin());
    // The page shell needs the whole runtime; the consent form, its headers and its action do not.
    spies.push(
      spyOn(cloudSsr, "Layout").mockImplementation(((props: { c: Parameters<typeof getLocale>[0]; children: JSX.Element }) =>
        createComponent(LocaleProvider, {
          locale: getLocale(props.c),
          get children() {
            return props.children;
          },
        })) as never),
    );
    const { default: pages } = await import("./frontend");
    const app = new Hono<AuthContext>()
      .use("/oauth/consent", async (c, next) => {
        if (c.req.method === "POST") consentOrigins.push(c.req.header("origin") ?? "(none)");
        await next();
      })
      .route("/", pages);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
    origin = server.url.origin;
    listener = Bun.serve({ hostname: "localhost", port: 0, fetch: () => new Response("Authentication complete") });
    callbackUri = `http://localhost:${listener.port}/callback`;
    previousAppUrl = await get("app.url");
    await set("app.url", origin);
    invalidateIdentityRuntimeConfig();

    const suffix = crypto.randomUUID();
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail, given_name, sn, admin)
      VALUES (${`oauth-consent-${suffix}`}, 'local', 'user', 'Consent Browser', ${`oauth-consent-${suffix}@example.test`}, 'Consent', 'Browser', false)
      RETURNING id
    `;
    userId = row!.id;
    sessionToken = await createTestSession(userId);
    browser = await launchBrowser();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop(true);
    await listener?.stop(true);
    for (const spy of spies.splice(0)) spy.mockRestore();
    if (typeof previousAppUrl === "string") await set("app.url", previousAppUrl);
    invalidateIdentityRuntimeConfig();
    if (clientIds.length > 0) await sql`DELETE FROM oauth.clients WHERE client_id IN ${sql(clientIds)}`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    rmSync(root, { recursive: true, force: true });
  });

  /** Registers a client over HTTP as an MCP client does, then opens its authorization request in the browser. */
  const openConsent = async (locale: string, state: string) => {
    // Per-IP limits count in the shared test Valkey; a fresh address keeps other test runs out of this budget.
    const caller = { "x-forwarded-for": uniqueCallerAddress() };
    const registration = await fetch(`${origin}/oauth/register`, {
      method: "POST",
      headers: { ...caller, "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [callbackUri], application_type: "native" }),
    });
    expect(registration.status).toBe(201);
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    clientIds.push(clientId);

    const context = await browser.newContext({ locale, extraHTTPHeaders: caller });
    await context.addCookies([{ name: "session_token", value: sessionToken, url: origin }]);
    const page = await context.newPage();
    const resource = `${origin}/api/mcp/v1`;
    await page.goto(
      `${origin}/oauth/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUri,
        response_type: "code",
        scope: "read write offline_access",
        resource,
        state,
        code_challenge: await pkceChallenge(),
        code_challenge_method: "S256",
      })}`,
    );
    expect(new URL(page.url()).pathname).toBe("/oauth/consent");
    return { context, page, clientId, resource, caller };
  };

  /** Submits the consent form with one of its buttons and returns the parameters the loopback callback received. */
  const decide = async (page: Page, button: string) => {
    consentOrigins.length = 0;
    await Promise.all([page.waitForURL((url) => url.pathname !== "/oauth/consent"), page.getByRole("button", { name: button }).click()]);
    // A form posted from the consent page carries Cloud's own origin, never `null`.
    expect(consentOrigins).toEqual([origin]);
    const callback = new URL(page.url());
    expect(`${callback.origin}${callback.pathname}`).toBe(callbackUri);
    return callback.searchParams;
  };

  /** A decision for the same request that a browser could only send from another page. */
  const forge = async (requestId: string, forgedOrigin: string) => {
    const response = await fetch(`${origin}/oauth/consent`, {
      method: "POST",
      headers: {
        cookie: `session_token=${sessionToken}`,
        "content-type": "application/x-www-form-urlencoded",
        "x-forwarded-for": uniqueCallerAddress(),
        origin: forgedOrigin,
      },
      body: new URLSearchParams({ request: requestId, decision: "approve" }),
      redirect: "manual",
    });
    return response.headers.get("location");
  };

  test("approving returns a code to the loopback callback that the client exchanges for a resource-bound token", async () => {
    const { context, page, clientId, resource, caller } = await openConsent("de-DE", "approve-state");
    try {
      const params = await decide(page, "Zugriff erlauben");
      expect(params.get("state")).toBe("approve-state");
      expect(params.get("iss")).toBe(origin);
      const code = params.get("code");
      expect(code).toBeTruthy();

      const exchange = await fetch(`${origin}/oauth/token`, {
        method: "POST",
        headers: { ...caller, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code: code!,
          redirect_uri: callbackUri,
          resource,
          code_verifier: VERIFIER,
        }),
      });
      expect(exchange.status).toBe(200);
      const tokens = (await exchange.json()) as { access_token: string; refresh_token: string };
      expect(await oauthTokens.verifyAccessToken(tokens.access_token, resource)).not.toBeNull();
      expect(tokens.refresh_token).toStartWith("cld_rt_");
    } finally {
      await context.close();
    }
  }, 60_000);

  test("denying returns access_denied to the loopback callback after forged decisions failed", async () => {
    const { context, page } = await openConsent("en-US", "deny-state");
    try {
      // Another site's form sends its own origin, and a sandboxed or `no-referrer` page elsewhere sends `null`.
      // Both fail before the request is used, so the person's own decision still counts.
      const requestId = new URL(page.url()).searchParams.get("request")!;
      for (const forgedOrigin of ["https://attacker.example", "null"]) {
        expect(await forge(requestId, forgedOrigin)).toStartWith("/oauth/error?error=invalid_request");
      }
      const params = await decide(page, "Deny");
      expect(params.get("error")).toBe("access_denied");
      expect(params.get("state")).toBe("deny-state");
      expect(params.get("iss")).toBe(origin);
      expect(params.has("code")).toBe(false);
    } finally {
      await context.close();
    }
  }, 60_000);

  test("the consent page keeps its address from other sites but sends its origin to Cloud", async () => {
    const response = await fetch(`${origin}/oauth/consent?request=${crypto.randomUUID()}`, {
      headers: { cookie: `session_token=${sessionToken}` },
      redirect: "manual",
    });
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });
});
