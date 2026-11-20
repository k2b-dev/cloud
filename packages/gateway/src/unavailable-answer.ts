import {
  APP_UNAVAILABLE_RETRY_AFTER_SECONDS,
  formatUnavailableHeader,
  GATEWAY_STATUS_PATH,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  type MaintenanceProblem,
  UNAVAILABLE_HEADER,
  type UnavailableSignal,
} from "@k2b/cloud/contracts/maintenance";
import { resolveLocale } from "@k2b/cloud/server/locale.ts";
import type { AppUnavailableReason, Availability } from "./availability";
import { type MaintenancePageModel, renderMaintenancePage } from "./maintenance-page";

/** A browser navigation gets the page; every API, script and socket gets problem JSON. */
export const wantsPage = (req: Request): boolean =>
  (req.method === "GET" || req.method === "HEAD") &&
  req.headers.get("Upgrade")?.toLowerCase() !== "websocket" &&
  (req.headers.get("Accept") ?? "").toLowerCase().includes("text/html");

const pageLocale = (req: Request, operatorDefault: string): "de" | "en" => {
  try {
    return new Intl.Locale(resolveLocale(req.headers, operatorDefault)).language === "de" ? "de" : "en";
  } catch {
    return "en";
  }
};

const nonce = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");

export const contentSecurityPolicy = (value: string): string =>
  [
    "default-src 'none'",
    `script-src 'nonce-${value}'`,
    `style-src 'nonce-${value}'`,
    "img-src data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

const answer = (
  req: Request,
  retryAfter: number,
  signal: UnavailableSignal,
  problem: MaintenanceProblem,
  page: () => MaintenancePageModel,
): Response => {
  const headers = new Headers({ "Retry-After": String(retryAfter), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  if (!wantsPage(req)) {
    headers.set("Content-Type", "application/problem+json");
    // The reason also without a body (HEAD); the page answer is for navigations and needs none.
    headers.set(UNAVAILABLE_HEADER, formatUnavailableHeader(signal));
    return new Response(req.method === "HEAD" ? null : JSON.stringify(problem), { status: 503, headers });
  }
  const value = nonce();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", contentSecurityPolicy(value));
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(req.method === "HEAD" ? null : renderMaintenancePage(page(), { nonce: value }), { status: 503, headers });
};

const image = (src: string | undefined) => (src ? { src } : undefined);

const cloudModel = (availability: Availability, locale: "de" | "en") => {
  const branding = availability.branding();
  const logo = image(branding.logo);
  return {
    locale,
    cloud: { name: branding.name, ...(logo ? { logo } : {}) },
    timeZone: branding.timeZone,
    statusPath: GATEWAY_STATUS_PATH,
  };
};

/** Whole-Cloud maintenance: the same answer on the Cloud host and on app domains, never with person names. */
export const maintenanceAnswer = (req: Request, availability: Availability): Response => {
  const state = availability.maintenance();
  const until = state?.until;
  return answer(
    req,
    MAINTENANCE_RETRY_AFTER_SECONDS,
    { code: "maintenance" },
    {
      type: "about:blank",
      title: "Cloud is in maintenance",
      status: 503,
      code: "maintenance",
      ...(until ? { until: new Date(until).toISOString() } : {}),
    },
    () => ({
      ...cloudModel(availability, pageLocale(req, availability.branding().locale)),
      kind: "cloud",
      ...(state?.message ? { message: state.message } : {}),
      ...(until ? { until } : {}),
    }),
  );
};

/**
 * One app restarting or unreachable. `cloudHost` adds the way back to the start page; app domains have none.
 * Core is the Cloud itself, so its page never offers the start page it cannot serve.
 */
export const appUnavailableAnswer = (
  req: Request,
  availability: Availability,
  appId: string,
  { reason = availability.reasonFor(appId), cloudHost }: { reason?: AppUnavailableReason; cloudHost: boolean },
): Response => {
  const locale = pageLocale(req, availability.branding().locale);
  const app = availability.appView(appId, locale);
  // Open pages name the app with this when their shell does not know it; an unknown app has no name but its id.
  const appName = app.name !== appId ? { appName: app.name } : {};
  return answer(
    req,
    APP_UNAVAILABLE_RETRY_AFTER_SECONDS,
    { code: "app_unavailable", appId, reason },
    { type: "about:blank", title: "App is unavailable", status: 503, code: "app_unavailable", appId, ...appName, reason },
    () => {
      const icon = image(app.icon);
      return {
        ...cloudModel(availability, locale),
        kind: "app",
        app: { id: app.id, name: app.name, ...(icon ? { icon } : {}), ...(app.iconColor ? { accent: app.iconColor } : {}) },
        reason,
        ...(cloudHost && appId !== "core" ? { homeHref: "/" } : {}),
      };
    },
  );
};

/** `GET|HEAD /_cloud/gateway/status[?app=<id>]`: public, uncached, from memory only. */
export const statusAnswer = (
  req: Request,
  url: URL,
  availability: Availability,
  { bypass = false }: { bypass?: boolean } = {},
): Response => {
  const app = url.searchParams.get("app");
  return new Response(req.method === "HEAD" ? null : JSON.stringify(availability.status(app, { bypass })), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
};
