import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { createConfig } from "@k2b/ssr";
import type { MiddlewareHandler } from "hono";
import { createComponent } from "solid-js";

// Every page a person sees during an authorization, rendered as the full HTML document the SSR
// framework sends. Pages that need no database go through their real route handlers; the
// confirmation and consent states render their real components inside the same page shell.
const root = mkdtempSync(resolve(tmpdir(), "oauth-authorization-pages-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Hono } = await import("hono");
const { ssr } = await import("../config");
const { AuthorizationPage } = await import("./_components/AuthorizationPage");
const { ConsentDecision } = await import("./_components/ConsentDecision");
const { DeviceApproval } = await import("./_components/DeviceApproval");
const { default: devicePage } = await import("./device");
const { default: errorPage } = await import("./error");
const { oauthMessages } = await import("./messages");

/** Synthetic data only. */
export const sample = {
  request: "11111111-1111-4111-8111-111111111111",
  code: "WDJB-MJHT",
  scopes: ["openid", "read", "write", "offline_access"],
  cli: { name: "Cloud CLI", clientId: "cloud-cli" },
  dynamic: { name: "Example Assistant", clientId: "dyn_3f9c2a7e5b1d4c8a" },
} as const;

// Core's legal links, so the footer looks as it does in a running Cloud.
const legalApp = {
  id: "legal-probe",
  presentation: {
    baseLocale: "en",
    translations: {
      de: { legalLinks: { "/impressum": "Impressum", "/legal/privacy": "Datenschutz", "/legal/terms": "Nutzungsbedingungen" } },
    },
  },
  legalLinks: [
    { label: "Imprint", href: "/impressum" },
    { label: "Privacy", href: "/legal/privacy" },
    { label: "Terms", href: "/legal/terms" },
  ],
};

/** A signed-in web session, as the routes' auth middleware leaves it. */
const signedIn: MiddlewareHandler<AuthContext> = async (c, next) => {
  // middleware.runtime() would read the live registry; the footer only needs the legal links.
  c.set("runtime" as never, { apps: [legalApp] } as never);
  c.set("credentialKind", "session" as never);
  c.set("sessionKind", "web" as never);
  c.set("actor", { kind: "user", sessionKind: "web", user: { id: "22222222-2222-4222-8222-222222222222" } } as never);
  await next();
};

/** The mobile app's session, which may not grant access to another application. */
const appSession: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("sessionKind", "app" as never);
  await next();
};

/** The sign-in that returns to the page; the real pages build it the same way. */
const reauthenticateHref = (path: string) => `/auth/login?${new URLSearchParams({ redirectTo: `${path}&reauthenticate=1` })}`;

const confirmPage = (reauthenticate: boolean) =>
  ssr<AuthContext>(
    async (c) => () =>
      createComponent(AuthorizationPage, {
        c,
        title: oauthMessages.resolve([getLocale(c)]).t.deviceTitle,
        get children() {
          return createComponent(DeviceApproval, {
            view: {
              kind: "confirm",
              reauthenticateHref: reauthenticate ? reauthenticateHref(`/oauth/device?user_code=${sample.code}`) : null,
              request: sample.request,
              code: sample.code,
              client: sample.cli,
              scopes: [...sample.scopes],
            },
          });
        },
      }),
  );

const consentPage = (client: "dynamic" | "cli", reauthenticate: boolean) =>
  ssr<AuthContext>(
    async (c) => () =>
      createComponent(AuthorizationPage, {
        c,
        title: oauthMessages.resolve([getLocale(c)]).t.authorizeApplication,
        get children() {
          return createComponent(ConsentDecision, {
            view: {
              request: sample.request,
              firstParty: client === "cli",
              reauthenticateHref: reauthenticate ? reauthenticateHref(`/oauth/consent?request=${sample.request}`) : null,
              client: sample[client],
              resource: client === "cli" ? null : "https://cloud.example/api/mcp/v1",
              redirectHost: client === "cli" ? "127.0.0.1:53682" : "localhost:53682",
              scopes: client === "cli" ? [...sample.scopes] : ["read", "write", "offline_access"],
            },
          });
        },
      }),
  );

const pages = new Hono<AuthContext>()
  .use("*", signedIn)
  .use("/fixture/app-session/*", appSession)
  .get("/oauth/device", ...devicePage)
  .get("/fixture/app-session/oauth/device", ...devicePage)
  .get("/oauth/error", ...errorPage)
  .get("/fixture/device-confirm", ...confirmPage(false))
  .get("/fixture/device-confirm-reauthenticate", ...confirmPage(true))
  .get("/fixture/consent", ...consentPage("dynamic", false))
  .get("/fixture/consent-cli", ...consentPage("cli", false))
  .get("/fixture/consent-reauthenticate", ...consentPage("dynamic", true));

/** Every authorization state by name, as the path a browser would open. */
export const authorizationStates = {
  entry: "/oauth/device",
  confirm: "/fixture/device-confirm",
  confirmReauthenticate: "/fixture/device-confirm-reauthenticate",
  consent: "/fixture/consent",
  consentCli: "/fixture/consent-cli",
  consentReauthenticate: "/fixture/consent-reauthenticate",
  approved: "/oauth/device?result=approved",
  denied: "/oauth/device?result=denied",
  expired: "/oauth/device?result=expired",
  blocked: "/fixture/app-session/oauth/device",
  error: `/oauth/error?${new URLSearchParams({ error: "access_denied", error_description: "Your account is not allowed to use this application." })}`,
} as const;

export type AuthorizationState = keyof typeof authorizationStates;

/** The complete HTML document of one state in one language and theme. */
export const renderAuthorizationState = async (
  state: AuthorizationState,
  locale: "en" | "de",
  theme: "light" | "dark" = "light",
): Promise<string> => {
  const response = await pages.request(`https://cloud.test${authorizationStates[state]}`, {
    headers: { "Accept-Language": locale, Cookie: `theme=${theme}` },
  });
  // A session that may not grant access gets its answer as 403.
  const status = state === "blocked" ? 403 : 200;
  if (response.status !== status) throw new Error(`${state} answered ${response.status}`);
  return response.text();
};
