import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { AppMeta, Role, User } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { appPublicRouteMatcher } from "@k2b/cloud/server/middleware/app-access";
import { canUseApp } from "@k2b/cloud/services";
import { discoverableApps } from "@k2b/cloud/services/app-discovery";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { visibleNavigationApps } from "@k2b/cloud/ssr/app-navigation";
import { appIds } from "../../../scripts/workspace";

// The workspace is authoritative: a newly added built-in must make a deliberate
// migration choice here, rather than silently keeping the third-party fallback.
const rules = {
  core: "signedIn",
  accounts: "signedIn",
  "api-docs": "signedIn",
  assistant: "signedIn",
  capabilities: "signedIn",
  chat: "signedIn",
  contacts: "signedIn",
  dashboard: "signedIn",
  faq: "signedIn",
  filesv2: "signedIn",
  "gateway-ops": "roles",
  grids: "signedIn",
  "ipa-hosts": "roles",
  mail: "signedIn",
  notebooks: "signedIn",
  oauth: "roles",
  "proxy-auth": "roles",
  pulse: "signedIn",
  pwa: "signedIn",
  quotes: "signedIn",
  spaces: "signedIn",
  tools: "signedIn",
  venue: "signedIn",
  weather: "signedIn",
} satisfies Record<string, "signedIn" | "roles">;
const apps: AppMeta[] = await Promise.all(
  appIds()
    .filter((id) => id !== "gateway")
    .map(async (id) => {
      const definition: { app: { meta: AppMeta } } = await import(`../../${id}/src/config.ts`);
      return definition.app.meta;
    }),
);
const person = (roles: Role[] = ["user"], guest = false, phone = false): RequestAuthority => {
  const projected = buildProjectedUser({
    id: "11111111-1111-4111-8111-111111111111",
    provider: "local",
    profile: guest ? "guest" : "user",
    effective_admin: false,
  });
  const user: User = { ...projected, roles };
  return {
    actor: { kind: "user", user, ...(phone ? { sessionKind: "app" as const } : {}) },
    accessSubject: { type: "user", userId: user.id },
    credentialKind: "session",
    scopes: [],
  };
};
const service = (
  appId: string,
  kind: "standalone" | "resource_bound" | "agent" | "user_delegated",
  scopes = ["read"],
  admin = false,
): RequestAuthority => {
  const owner = person(admin ? ["user", "admin"] : ["user"]);
  if (owner.actor.kind !== "user") throw new Error("Expected a user fixture");
  const accountId = "22222222-2222-4222-8222-222222222222";
  const delegatedUser = kind === "user_delegated" ? owner.actor.user : null;
  return {
    actor: {
      kind: "service_account",
      scopes,
      delegatedUser,
      serviceAccount: {
        id: accountId,
        kind,
        name: "Migration test",
        status: "active",
        delegatedUserId: delegatedUser?.id ?? null,
        appId: kind === "resource_bound" ? appId : null,
        resourceType: kind === "resource_bound" ? "fixture" : null,
        resourceId: kind === "resource_bound" ? "fixture" : null,
        createdBy: null,
        createdAt: "2026-10-22T00:00:00.000Z",
      },
    },
    accessSubject: delegatedUser ? { type: "user", userId: delegatedUser.id } : { type: "service_account", serviceAccountId: accountId },
    credentialKind: "api_key",
    scopes,
  };
};
// Concrete paths exercise Hono parameters and wildcard tails, including routes
// whose credentials ordinary Cloud authentication must never consume.
const publicPaths: Record<string, string[]> = {
  core: [
    "/auth/login",
    "/auth/new-password",
    "/auth/password-reset",
    "/auth/continue",
    "/api/auth/login",
    "/api/auth/passkeys/authentication/start",
    "/api/auth/passkeys/authentication/verify",
    "/api/auth/email-login",
    "/api/auth/verify-token",
    "/api/auth/change-expired-password",
    "/api/auth/legal-consent",
    "/api/auth/password-reset/request",
    "/api/auth/password-reset/complete",
    "/api/auth/admin-login",
    "/api/auth/logout",
    "/api/auth/app-approval/v1/info",
    "/api/auth/app-approval/v1/pairings/claim",
    "/api/auth/app-approval/v1/pairings/result",
    "/api/auth/app-approval/v1/device",
    "/api/auth/app-approval/v1/login/start",
    "/api/auth/app-approval/v1/login/status",
    "/api/auth/app-approval/v1/login/complete",
    "/pwa/_auth/pairings/claim",
    "/pwa/_auth/pairings/complete",
    "/pwa/_auth/session/launch",
    "/pwa/_auth/session/renew",
    "/pwa/_auth/session",
    "/.well-known/cloud-session-jwks.json",
    "/.well-known/cloud-invocation-jwks.json",
    "/.well-known/oauth-protected-resource/api/mcp/v1",
    "/api/mcp/v1",
    "/api/capabilities/v1/catalog",
    "/api/capabilities/v1/commands/notebooks/compose",
    "/api/capabilities/v1/queries/notebooks/get",
    "/api/capabilities/v1/actions/notebooks/rename",
    "/api/capabilities/v1/actions/notebooks/rename/review",
    ...["read", "write", "status", "abort"].map((verb) => `/api/capabilities/v1/streams/${verb}`),
    "/api/apps",
    "/api/ai/skills",
    "/api/ai/skills/example",
    "/cli/plugins",
    "/api/help/v1/notebooks/search",
    "/api/help/v1/notebooks/documents/start",
    "/help/apps/notebooks",
    "/help/apps/notebooks/start",
    "/panel",
    "/api/search",
    "/api/widgets/v1",
    "/api/widgets/v1/notebooks/recent",
    "/_cloud/app-access/inventory",
    "/open/notebooks.notebook/~fixture",
    "/api/_internal/identity/v1/invoke",
    "/api/_internal/identity/v1/invoke-child",
    "/api/_internal/ai/code/execute",
    "/api/_internal/identity/v1/mandates/mandate",
    ...["confirm", "policy", "pause", "revoke"].map((verb) => `/api/_internal/identity/v1/mandates/mandate/${verb}`),
    "/api/_internal/identity/v1/oauth/ready",
    "/api/_internal/identity/v1/oauth/token",
    "/api/_internal/identity/v1/oauth/device-approval",
    "/api/ai/openai/v1/models",
    "/api/ai/openai/v1/chat/completions",
    "/cli",
    "/service-worker.js",
    "/legal/terms",
    "/legal/privacy",
    "/impressum",
    "/branding/logo",
    "/branding/favicon",
    ...["pwa-icon-192", "pwa-icon-512", "pwa-icon-maskable-512", "apple-touch-icon"].map((variant) => `/branding/${variant}.png`),
  ],
  "api-docs": ["/app/api-docs", "/api/api-docs/sources"],
  assistant: [
    "/_internal/assistant/tools/execute",
    "/app/assistant/apps/studio/run",
    "/api/assistant/runner/app-assets",
    "/api/assistant/runner/chunks/bridge.js",
    "/api/assistant/runner/studio",
    "/api/assistant/runner/studio/app",
  ],
  faq: ["/faq"],
  filesv2: [
    "/share/filesv2/s/token",
    "/share/filesv2/s/token/api",
    "/share/filesv2/s/token/api/unlock",
    "/share/filesv2/s/token/api/download",
    "/share/filesv2/s/token/api/archive",
    "/share/filesv2/inbox/token",
    "/share/filesv2/inbox/token/api",
    "/share/filesv2/inbox/token/api/unlock",
    "/share/filesv2/inbox/token/api/uploads",
    ...["lease", "commit", "abort"].map((verb) => `/share/filesv2/inbox/token/api/uploads/upload/${verb}`),
    "/api/filesv2/wopi/files/file",
    "/api/filesv2/wopi/files/file/contents",
  ],
  "gateway-ops": [
    "/metrics",
    "/api/notifications",
    "/api/notifications/summary",
    "/api/notifications/notification",
    "/api/notifications/notification/resend",
  ],
  grids: [
    "/share/grids/forms/token",
    "/share/grids/documents/token",
    "/share/grids/documents/token/download",
    "/apps/published",
    "/apps/published/page",
    "/api/grids/forms/public/token",
    "/api/grids/forms/public/token/submit",
    "/api/grids/forms/public/token/relations/field/lookup",
    "/api/grids/apps/runtime/published",
    "/api/grids/apps/runtime/published/page",
    "/api/grids/apps/runtime/published/page/block/records",
    "/api/grids/apps/runtime/published/page/block/submit",
    "/api/grids/apps/runtime/published/page/block/files/token",
    "/api/grids/apps/runtime/published/sidebar/forms/action/relations/field/lookup",
  ],
  mail: ["/share/mail/attachments/token"],
  oauth: [
    "/.well-known/openid-configuration",
    "/.well-known/oauth-authorization-server",
    "/.well-known/jwks.json",
    ...["register", "authorize", "device_authorization", "token", "revoke", "userinfo", "logout", "consent", "device", "error"].map(
      (path) => `/oauth/${path}`,
    ),
  ],
  "proxy-auth": ["/proxy-auth/verify/client"],
  pulse: ["/api/pulse/ingest"],
  pwa: ["/pwa", "/pwa/", "/pwa/manifest.webmanifest", "/pwa/sw.js"],
  quotes: ["/api/quotes", "/api/quotes/widget/quote"],
  tools: [
    "/tools",
    ...[
      "mailto",
      "qr",
      "encoding",
      "uuid",
      "hash",
      "lorem",
      "color",
      "image-converter",
      "image",
      "encryption",
      "password",
      "speedtest",
      "webhooks",
    ].map((path) => `/tools/${path}`),
    ...["ping", "download", "upload", "cli", "cli.py"].map((path) => `/tools/api/speedtest/${path}`),
    "/tools/api/webhooks/receive/token",
    "/tools/api/webhooks/receive/token/arbitrary/nested/path",
  ],
  venue: [
    "/app/venue/public/venue",
    "/app/venue/public/venue/feedback",
    "/api/venue/public/venue/status",
    "/api/venue/public/venue/feedback",
    "/api/venue/calendar/token",
  ],
};
const protectedPaths: Record<string, string[]> = {
  core: [
    "/me",
    "/admin",
    "/api/auth/pwa/v1/pairings",
    "/api/auth/app-approval/v1/manage/devices",
    "/api/auth/app-approval/v1/manage/pairings/start",
    "/api/auth/app-approval/v1/device/private",
    "/api/auth/app-approval/v1/login/start/private",
    "/pwa/_auth/session/private",
    "/api/admin/identity",
    "/api/ai/tasks",
    "/api/_internal/identity/v1/other",
    "/api/capabilities/v1/streams/other",
    "/api/capabilities/v1/catalog/extra",
    "/api/capabilities/v1/queries/notebooks/get/extra",
    "/api/capabilities/v1/actions/notebooks/rename/review/extra",
    "/api/apps/extra",
    "/cli/plugins/private/extra",
    "/api/help/v1/notebooks/private",
    "/help/apps/notebooks/start/extra",
    "/panel/private",
    "/api/search/private",
    "/api/widgets/v1/notebooks/recent/private",
    "/_cloud/app-access/inventory/private",
    "/open/notebooks.notebook/~fixture/private",
  ],
  "api-docs": ["/api/api-docs/private"],
  assistant: ["/api/assistant/artifacts", "/app/assistant/apps/studio/edit", "/admin/assistant"],
  faq: ["/admin/faq", "/api/faq"],
  filesv2: ["/api/filesv2/bases", "/api/filesv2/admin/shares", "/api/filesv2/wopi/other"],
  "gateway-ops": [
    "/api/gateway/health",
    "/admin/gateway/apps",
    "/metrics/other",
    "/api/notifications/pending-system/count",
    "/api/notifications/pending-system/send-all",
  ],
  grids: ["/api/grids/bases", "/api/grids/forms/private", "/api/grids/apps/by-base/base", "/admin/grids"],
  mail: ["/api/mail/mailboxes", "/share/mail/other"],
  oauth: ["/api/oauth/admin/clients", "/admin/oauth", "/oauth/token/other"],
  "proxy-auth": ["/admin/proxy-auth", "/api/proxy-auth", "/proxy-auth/other"],
  pulse: ["/api/pulse/bases", "/admin/pulse", "/api/pulse/ingest/private"],
  pwa: ["/pwa/settings"],
  quotes: ["/api/quotes/other"],
  tools: ["/tools/document-markdown", "/tools/markdown-pdf", "/tools/api/webhooks/endpoints", "/tools/api/webhooks/send"],
  venue: ["/api/venue/venues", "/app/venue/private", "/api/venue/templates"],
};

test("every workspace built-in declares an intentional fixed policy; gateway remains a proxy", () => {
  expect(apps.map((app) => app.id).sort()).toEqual(Object.keys(rules).sort());
  expect(readFileSync(new URL("../../gateway/src/config.ts", import.meta.url), "utf8")).not.toContain("defineApp(");
});

for (const app of apps)
  describe(`${app.id} access migration`, () => {
    const adminOnly = Object.entries(rules).some(([id, kind]) => id === app.id && kind === "roles");
    test("requires resolved identity and preserves supported person and service-account categories", async () => {
      expect(app.access?.kind).toBe(adminOnly ? "roles" : "signedIn");
      if (adminOnly) expect(app.access).toMatchObject({ roles: ["admin"] });
      expect(await canUseApp(null, app)).toBe(false);
      expect(await canUseApp(person(["user", "admin"]), app)).toBe(true);
      for (const authority of [person(), person(["guest"], true), person([], true), person(["user"], false, true)]) {
        expect(await canUseApp(authority, app)).toBe(!adminOnly);
        expect((await discoverableApps(authority, [app])).length).toBe(adminOnly ? 0 : 1);
      }
      for (const kind of ["standalone", "agent", "resource_bound"] as const) {
        expect(await canUseApp(service(app.id, kind), app)).toBe(!adminOnly);
        expect(await canUseApp(service(app.id, kind, [`${app.id}:read`]), app)).toBe(!adminOnly);
        expect(await canUseApp(service(app.id, kind, ["different-app:read"]), app)).toBe(false);
      }
      expect(await canUseApp(service("different-app", "resource_bound"), app)).toBe(false);
      expect(await canUseApp(service(app.id, "user_delegated", []), app)).toBe(!adminOnly);
      expect(await canUseApp(service(app.id, "user_delegated", [], true), app)).toBe(true);
      expect(await canUseApp(service(app.id, "user_delegated", ["ai:inference"], true), app)).toBe(false);
    });
    test("entry access keeps finer navigation placement constraints", async () => {
      for (const authority of [person(), person(["guest"], true), person(["user"], false, true), person(["user", "admin"])]) {
        if (authority.actor.kind !== "user") throw new Error("Expected a user fixture");
        const before = visibleNavigationApps([app], authority.actor.user).map((entry) => entry.id);
        const after = visibleNavigationApps(await discoverableApps(authority, [app]), authority.actor.user).map((entry) => entry.id);
        expect(after).toEqual(before);
      }
    });
    test("public and specialized-auth paths bypass entry, without exempting private neighbors", () => {
      const matches = appPublicRouteMatcher(app);
      for (const path of publicPaths[app.id] ?? []) expect(matches(path)).toBe(true);
      if (app.openapi) expect(matches(app.openapi)).toBe(true);
      for (const path of protectedPaths[app.id] ?? [`/api/${app.id}/private`, `/admin/${app.id}`]) expect(matches(path)).toBe(false);
      expect(matches(`/api/${app.id}/openapi.json/extra`)).toBe(false);
      expect(matches("/unrelated")).toBe(false);
      // Every declared pattern has a concrete witness above (or the spec URL).
      // A newly introduced exception must add a representative migration case.
      for (const pattern of app.access?.publicRoutes ?? []) {
        const onlyPattern = { ...app, access: { kind: "signedIn" as const, publicRoutes: [pattern] } };
        expect([...(publicPaths[app.id] ?? []), ...(app.openapi ? [app.openapi] : [])].some(appPublicRouteMatcher(onlyPattern))).toBe(true);
      }
    });
  });
