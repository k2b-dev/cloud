/** Synthetic admin and data; the real AdminLayout, Observability area views, islands and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import { type Context, Hono } from "hono";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import type { HealthApp, HealthWebhook } from "../../frontend/health-webhook-queries";

/** States the captures and tests switch with `?state=`. */
export type ObservabilityFixtureState = "normal" | "empty" | "loadfail" | "unreadable" | "savefail" | "saving";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "demo-admin",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

const webhook = (id: string, name: string, url: string, extra: Partial<HealthWebhook> = {}): HealthWebhook => ({
  id,
  name,
  url,
  method: "POST",
  enabled: true,
  scopeKind: "all",
  scopeAppIds: [],
  sendOn: ["error", "recovery"],
  minStatus: "error",
  repeatIntervalMs: 1_800_000,
  timeoutMs: 5000,
  lastStatus: "ok",
  lastSentAt: "2026-10-12T07:14:00.000Z",
  lastError: null,
  ...extra,
});

export const fixtureWebhooks = (): HealthWebhook[] => [
  webhook("aaaaaaaa-0000-4000-8000-000000000001", "Bereitschaft", "https://hooks.example.org/bereitschaft"),
  webhook("aaaaaaaa-0000-4000-8000-000000000002", "Fehlerquote Mail", "https://hooks.example.org/mail", {
    scopeKind: "include",
    scopeAppIds: ["mail"],
    minStatus: "warn",
  }),
  webhook("aaaaaaaa-0000-4000-8000-000000000003", "Jobs hängen", "https://hooks.example.org/jobs", {
    lastStatus: "warn",
    lastError: "Zeitüberschreitung nach 5 s",
  }),
  webhook("aaaaaaaa-0000-4000-8000-000000000004", "Speicher knapp", "https://hooks.example.org/speicher", {
    enabled: false,
    lastSentAt: null,
  }),
];

const apps: HealthApp[] = [
  { id: "mail", name: "Mail", icon: "ti ti-mail", status: "ok", online: true, signals: [] },
  { id: "spaces", name: "Spaces", icon: "ti ti-layout-kanban", status: "warn", online: true, signals: ["antwortet langsam"] },
  { id: "pulse", name: "Pulse", icon: "ti ti-activity-heartbeat", status: "ok", online: true, signals: [] },
];

const LOGS: [string, "error" | "warn" | "info", string, string, Record<string, unknown> | null][] = [
  [
    "10:42:18",
    "error",
    "mail",
    "IMAP-Abruf für Postfach „Info“ abgebrochen: Zeitüberschreitung nach 30 s",
    { mailbox: "mbx_info", host: "imap.example.org", timeoutMs: 30000, attempt: 3 },
  ],
  ["10:42:02", "warn", "gateway", "Upstream spaces antwortet langsam (2,4 s)", { upstream: "spaces", ms: 2400 }],
  ["10:41:57", "info", "core", "Anmeldung mit Passkey · Mia Muster", null],
  ["10:41:40", "info", "notebooks", "Export „Handbuch“ fertig (18 Seiten)", { pages: 18 }],
  ["10:41:12", "error", "pulse", "Ziel „Lager-Sensoren“ nicht erreichbar", { target: "lager-sensoren" }],
  ["10:40:55", "info", "files", "Freigabe-Link erstellt · Ordner „Angebote 2026“", null],
  ["10:40:31", "warn", "nats", "Consumer „mail-sync“ hinkt 1.204 Nachrichten hinterher", { consumer: "mail-sync", pending: 1204 }],
  ["10:40:02", "info", "assistant", "Hintergrundaufgabe „Wochenrückblick“ gestartet", null],
];
const logEntries = LOGS.map(([time, level, source, message, metadata], index) => ({
  id: String(9000 + index),
  level,
  source,
  message,
  metadata,
  createdAt: `2026-10-28T${time}.000Z`,
}));
const timeseries = Array.from({ length: 12 }, (_, index) => ({
  at: new Date(Date.parse("2026-10-28T09:45:00.000Z") + index * 5 * 60_000),
  debug: 0,
  info: 40 + ((index * 7) % 13),
  warn: index % 4 === 0 ? 3 : 1,
  error: index === 9 ? 4 : index % 5 === 0 ? 1 : 0,
  total: 0,
})).map((point) => ({ ...point, total: point.info + point.warn + point.error }));

const ui = new URL("../../../../ui/", import.meta.url).pathname;
const uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));

export async function observabilityAreaBrowserFixture(options: { port?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gateway-ops-area-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
  const { LogsView } = await import("../logs/view");
  const { AlertsView } = await import("../alerts/view");
  const { HealthCheckView } = await import("../health-check/view");
  const { RetentionView } = await import("../retention/view");
  const { NatsAccessView } = await import("../nats/access-view");
  const { defaultLogFilter } = await import("../logs/_components/types");

  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "ObservabilityArea.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-observability-area-fixture",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const transformed = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: transformed.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the Observability area islands");
  const script = await bundle.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../cloud/", import.meta.url).pathname))).default;
  const styles = await Promise.all(
    [resolve(import.meta.dir, "../../styles/app.css"), resolve(import.meta.dir, "../../../../../styles.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of styles) if (!build.success) throw new AggregateError(build.logs, "Could not compile page styles");
  const css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(styles.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  const fontCss =
    (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/fonts/") +
    icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/tabler-icons.woff2");
  const iconFile = resolve(uiDist, /tabler-icons-[\w-]+\.woff2/.exec(icons)![0]);

  let webhooks = fixtureWebhooks();
  type Variables = {
    runtime: CloudRuntime;
    user: User;
    settings: Record<string, unknown>;
    actor: undefined;
    panelConsent: undefined;
    railPreferences: undefined;
    announcements: undefined;
    page: { title?: string; theme: "light" | "dark" };
  };
  const pages = new Hono<{ Variables: Variables }>();
  const page =
    (render: (c: Parameters<typeof LogsView>[0]["c"], locale: string, state: ObservabilityFixtureState, url: URL) => JSX.Element) =>
    (c: Context<{ Variables: Variables }>) => {
      const url = new URL(c.req.url);
      const locale = url.searchParams.get("locale") === "en" ? "en" : "de";
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      const state = (url.searchParams.get("state") ?? "normal") as ObservabilityFixtureState;
      c.req.raw.headers.set("x-cloud-locale", locale);
      c.set("runtime", {
        apps: [
          { id: "core", name: "Core", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] },
          {
            id: "gateway-ops",
            name: "Gateway",
            description: "Operations",
            icon: "ti ti-route",
            routes: ["/admin/observability"],
            adminHref: "/admin/observability",
            adminNav: [
              {
                section: "observability",
                label: "Gateway",
                links: [{ href: "/admin/observability/gateway", icon: "ti-apps", label: "Apps" }],
              },
              {
                section: "observability",
                label: "Observability",
                links: [
                  { href: "/admin/observability", icon: "ti-stethoscope", label: "Overview" },
                  { href: "/admin/observability/logs", icon: "ti-list-details", label: "Logs" },
                ],
              },
            ],
          },
          { id: "mail", name: "Mail", description: "Mail", icon: "ti ti-mail", routes: ["/app/mail"], adminHref: "/admin/mail" },
          {
            id: "weather",
            name: "Wetter",
            description: "Wetter",
            icon: "ti ti-temperature-celsius",
            routes: ["/app/weather"],
            adminHref: "/admin/weather",
          },
        ],
      });
      c.set("user", user);
      c.set("settings", { app: { name: "Cloud", locale } });
      c.set("page", { title: "Observability", theme });
      const body = renderToString(() => render(c, locale, state, url));
      return c.html(
        `<!doctype html><html lang="${locale}" class="${theme}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fonts.css"><style>${css}</style></head><body class="k2b-ui">${body}<script src="/fixture.js"></script></body></html>`,
      );
    };
  const attention = { home: "warning" as const, nats: "warning" as const };

  pages.get(
    "/admin/observability/logs",
    page((c, locale, state, url) => {
      const selectedId = url.searchParams.get("entry");
      const entry = logEntries.find((candidate) => candidate.id === selectedId) ?? null;
      return createComponent(LogsView, {
        c,
        locale,
        timeZone: "UTC",
        attention,
        filter: defaultLogFilter,
        entries: state === "empty" || state === "loadfail" ? [] : logEntries,
        total: state === "empty" || state === "loadfail" ? 0 : 1932,
        totalPages: state === "empty" ? 1 : 20,
        baseUrl: "/admin/observability/logs?page=",
        sources: ["assistant", "core", "files", "gateway", "mail", "nats", "notebooks", "pulse"],
        loadError: state === "loadfail" ? "Der Log-Speicher antwortet nicht." : null,
        summary: { total: 48_210, errors24h: 12, warnings24h: 31, total24h: 6_120, sources: 8, lastErrorAt: "2026-10-28T10:42:18.000Z" },
        topSource: { key: "mail", count: 812 },
        timeseriesResult: { points: state === "empty" ? [] : timeseries, error: null },
        retentionDays: 14,
        selectedId,
        selected: selectedId ? { entry: entry as never, error: null } : null,
        retryHref: url.pathname + url.search,
      });
    }),
  );
  pages.get(
    "/admin/observability/alerts",
    page((c, locale, state, url) =>
      createComponent(AlertsView, {
        c,
        locale,
        timeZone: "UTC",
        attention,
        rows: state === "empty" || state === "loadfail" ? [] : webhooks,
        apps,
        loadError: state === "loadfail" ? "Die Datenbank antwortet nicht." : null,
        selectedId: url.searchParams.get("webhook"),
      }),
    ),
  );
  pages.get(
    "/admin/observability/health-check",
    page((c, locale, state) =>
      createComponent(HealthCheckView, { c, locale, attention, schedule: "*/5 * * * *", unreadable: state === "unreadable" }),
    ),
  );
  pages.get(
    "/admin/observability/retention",
    page((c, locale, state) =>
      createComponent(RetentionView, {
        c,
        locale,
        attention,
        values: { logs: 14, events: 14, rollups: 90 },
        unreadable: state === "unreadable" ? { events: true } : {},
      }),
    ),
  );

  pages.get(
    "/admin/observability/nats/access",
    page((c, locale, state) =>
      createComponent(NatsAccessView, {
        c,
        locale,
        attention,
        values: { servers: ["tls://nats.example:4222"], kind: "creds", ca: "" },
        unreadable: { servers: false, kind: false, access: state === "unreadable", ca: false },
      }),
    ),
  );

  const stateOf = (request: Request) =>
    (new URL(request.headers.get("referer") ?? "http://x/").searchParams.get("state") ?? "normal") as ObservabilityFixtureState;
  const api = async (request: Request, url: URL): Promise<Response> => {
    const state = stateOf(request);
    if (state === "saving" && request.method !== "GET") return new Promise(() => {});
    if (state === "savefail" && request.method !== "GET")
      return Response.json({ message: "Der Wert passt nicht zum erwarteten Format." }, { status: 400 });
    if (url.pathname === "/api/logging/settings/retention" && request.method === "PUT") return Response.json({ message: "ok" });
    if (url.pathname.startsWith("/api/gateway/settings/") && request.method === "PUT") return Response.json({ message: "ok" });
    const hook = url.pathname.match(/^\/api\/gateway\/health\/webhooks\/([^/]+)(\/test)?$/);
    if (hook && hook[2]) return Response.json({ message: "submitted" });
    if (hook && request.method === "PUT") {
      const body = (await request.json()) as Partial<HealthWebhook>;
      webhooks = webhooks.map((entry) => (entry.id === hook[1] ? { ...entry, ...body } : entry));
      return Response.json(webhooks.find((entry) => entry.id === hook[1]));
    }
    if (hook && request.method === "DELETE") {
      webhooks = webhooks.filter((entry) => entry.id !== hook[1]);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/api/gateway/health/webhooks" && request.method === "POST") {
      const created = { ...webhook("aaaaaaaa-0000-4000-8000-000000000005", "", ""), ...((await request.json()) as Partial<HealthWebhook>) };
      webhooks = [...webhooks, created];
      return Response.json(created);
    }
    return Response.json({ message: "Synthetic fixture: not available" }, { status: 503 });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname === "/fonts.css") return new Response(fontCss, { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/tabler-icons.woff2") return new Response(Bun.file(iconFile));
      if (url.pathname.startsWith("/fonts/")) return new Response(Bun.file(resolve(uiDist, `.${url.pathname}`)));
      if (url.pathname.startsWith("/api/")) return api(request, url);
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    reset() {
      webhooks = fixtureWebhooks();
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const fixture = await observabilityAreaBrowserFixture({ port: Number(Bun.argv[2] ?? 0) });
  console.log(fixture.url);
}
