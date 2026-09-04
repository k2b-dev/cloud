import { describe, expect, test } from "bun:test";

// Opt-in, read-only checks against a running full development stack.
// The optional token must belong to a user-backed administrator (no accounts are created).
const origin = process.env.CLOUD_PAGE_TEST_URL;
const adminToken = process.env.CLOUD_PAGE_TEST_ADMIN_TOKEN;
const request = (path: string, authenticated = false) =>
  fetch(new URL(path, origin), {
    redirect: "manual",
    headers: authenticated && adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
    signal: AbortSignal.timeout(15_000),
  });

const protectedPages = [
  "/admin",
  "/admin/faq",
  "/admin/contacts",
  "/admin/files",
  "/admin/grids",
  "/admin/notebooks",
  "/admin/mail",
  "/admin/mail/security",
  "/admin/spaces",
  "/admin/weather",
  "/admin/ipa-hosts",
  "/admin/proxy-auth",
  "/admin/oauth",
  "/admin/gateway/apps",
  "/admin/observability",
  "/me/profile",
  ...[
    "accounts",
    "assistant",
    "capabilities",
    "contacts",
    "dashboard",
    "files",
    "grids",
    "mail",
    "notebooks",
    "pulse",
    "spaces",
    "venue",
    "weather",
  ].map((app) => `/app/${app}`),
  "/tools/document-markdown",
  "/tools/markdown-pdf",
  "/oauth/consent",
];

const pagePrefixes = [
  ...[
    "accounts",
    "api-docs",
    "assistant",
    "capabilities",
    "contacts",
    "dashboard",
    "files",
    "grids",
    "mail",
    "notebooks",
    "pulse",
    "spaces",
    "venue",
    "weather",
  ].map((app) => `/app/${app}`),
  ...[
    "faq",
    "contacts",
    "files",
    "grids",
    "notebooks",
    "mail",
    "spaces",
    "weather",
    "ipa-hosts",
    "proxy-auth",
    "oauth",
    "gateway",
    "observability",
  ].map((app) => `/admin/${app}`),
  "/faq",
  "/tools",
  "/share/grids",
  "/apps",
];

const missingResources = [
  "/app/accounts/users/not-a-uuid",
  "/app/accounts/groups/not-a-uuid",
  "/app/accounts/notifications/not-a-uuid",
  "/app/accounts/users/00000000-0000-0000-0000-000000000000",
  "/app/assistant?project=not-a-real-id",
  "/app/assistant?conversation=not-a-real-id",
  "/app/capabilities/not-a-real-app",
  "/app/contacts/not-a-real-id",
  "/app/grids/not-a-real-id",
  "/app/grids/not-a-real-id/query-reference",
  "/app/grids/not-a-real-id/table/not-a-real-id/formula-reference",
  "/app/mail/not-a-real-id",
  "/app/mail/not-a-real-id/automations/incoming",
  "/app/mail/not-a-real-id/compose/not-a-real-id",
  "/app/notebooks/not-a-real-id",
  "/app/notebooks/not-a-real-id/attachments",
  "/app/pulse/not-a-real-id",
  "/app/pulse/not-a-real-id/query-reference",
  "/app/spaces/not-a-real-id",
  "/app/venue/not-a-real-id",
  "/app/weather/not-a-real-id",
];

describe.skipIf(!origin)("live Cloud document boundaries", () => {
  for (const path of protectedPages)
    test(`anonymous ${path} returns to login safely`, async () => {
      const target = `${path}?page-test=1`;
      const response = await request(target);
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!, origin);
      expect(location.pathname).toBe("/auth/login");
      expect(location.searchParams.get("redirectTo")).toBe(target);
      // Core can add stricter no-cache/revalidation directives around the page.
      expect(response.headers.get("cache-control")).toContain("no-store");
    }, 20_000);

  for (const prefix of pagePrefixes)
    test(`unmatched document under ${prefix}`, async () => {
      const response = await request(`${prefix}/not-a-real-page/unknown/deeply-nested`);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("k2b-not-found");
    }, 20_000);

  for (const path of ["/faq", "/tools", "/app/api-docs"])
    test(`public ${path} remains public`, async () => {
      const response = await request(path);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    }, 20_000);

  for (const path of [
    "/share/grids/documents/not-a-real-token",
    "/share/grids/forms/not-a-real-token",
    "/app/pulse/display/not-a-real-token",
    "/app/venue/public/not-a-real-token",
    "/app/venue/public/not-a-real-token/feedback",
  ])
    test(`public missing ${path}`, async () => {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(response.headers.get("location")).toBeNull();
    }, 20_000);

  for (const path of [
    "/tools/api/not-a-real-endpoint",
    "/app/accounts/_ssr/not-real.js",
    "/share/grids/documents/not-a-real-token/download",
  ])
    test(`non-page ${path} stays non-HTML`, async () => {
      const response = await request(path);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).not.toContain("text/html");
    }, 20_000);

  test("FAQ API authentication remains JSON", async () => {
    const response = await request("/api/faq");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
  }, 20_000);

  for (const path of missingResources)
    test.skipIf(!adminToken)(
      `authenticated missing ${path}`,
      async () => {
        const response = await request(path, true);
        expect(response.status).toBe(404);
        expect(response.headers.get("content-type")).toContain("text/html");
        expect(response.headers.get("location")).toBeNull();
      },
      20_000,
    );
});
