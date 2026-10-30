/** Synthetic admin and fictional apps; the real AdminLayout, Apps view, islands and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { ADMIN_ID, FIXTURE_NOW, fixtureApps, fixtureDetails, fixtureKeys } from "./AdminApps.fixture-data";

/** States the captures and tests switch with `?state=`, next to the page's own `app`, `view`, `window` and `moved`. */
export type AdminAppsFixtureState =
  | "normal"
  | "empty"
  | "failed"
  | "rejected"
  | "removed"
  | "provider"
  | "core-fail"
  | "router-unknown"
  | "keys-off"
  | "keys-error"
  | "keys-two"
  | "slow";

const user: User = {
  id: ADMIN_ID,
  uid: "alex",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Alex",
  sn: "Berger",
  displayName: "Alex Berger",
  mail: "alex.berger@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

export async function adminAppsBrowserFixture(options: { port?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "core-admin-apps-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
  const { AdminLayout } = await import("@k2b/cloud/ssr");
  const { AppsView } = await import("./view");
  const { appsFormat } = await import("./format");
  const { deriveApp, parseAppsQuery, sortApps } = await import("./model");
  const ui = resolve(import.meta.dir, "../../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AdminApps.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-admin-apps-fixture",
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
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the Apps page islands");
  const script = await bundle.outputs[0]!.text();
  const styles = await Promise.all(
    [resolve(import.meta.dir, "../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../styles.css")].map((entry) =>
      Bun.build({ entrypoints: [entry], plugins: [tailwind] }),
    ),
  );
  for (const build of styles) if (!build.success) throw new AggregateError(build.logs, "Could not compile page styles");
  const css = [
    "@layer properties, theme, base, components, utilities;",
    ...(await Promise.all(styles.map((build) => build.outputs[0]!.text()))),
  ].join("\n");
  const publicDir = join(root, "public");
  await (await import("../../../../scripts/font-assets")).buildFontAssets(publicDir);
  await (await import("../../../../scripts/tabler-assets")).buildTablerIconAssets(publicDir);

  let removed = new Set<string>();
  const pages = new Hono<{
    Variables: {
      runtime: CloudRuntime;
      user: User;
      settings: Record<string, unknown>;
      actor: undefined;
      panelConsent: undefined;
      railPreferences: undefined;
      announcements: undefined;
      page: { title?: string; theme: "light" | "dark" };
    };
  }>();
  pages.get("/admin/apps", (c) => {
    const locale = c.req.query("locale") === "en" ? "en" : "de";
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const state = (c.req.query("state") ?? "normal") as AdminAppsFixtureState;
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", {
      apps: fixtureApps()
        .filter((app) => app.live)
        .map((app) => ({ id: app.id, name: app.name, description: app.description, icon: app.icon, routes: [...app.routes] })),
    });
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    c.set("page", { title: "Apps", theme });
    const query = parseAppsQuery(c.req.query());
    const format = appsFormat({ locale, timeZone: "Europe/Berlin" }, FIXTURE_NOW);
    const inputs = fixtureApps()
      .filter((app) => !removed.has(app.id) && !(state === "removed" && app.id === "pulse"))
      .map((app) => (state === "provider" ? { ...app, numbers: [], numbersUnavailable: true } : app));
    const apps = sortApps(inputs.map(deriveApp), locale);
    const entry = apps.find((app) => app.id === query.app);
    const details = entry && state !== "core-fail" && entry.coreKnows && !entry.neverStarted ? fixtureDetails(entry.id, entry.name) : null;
    const keys = entry ? fixtureKeys(entry.id) : [];
    const view = query.view;
    const detail = (() => {
      if (!entry || !view) return null;
      if (view === "access")
        return {
          view,
          rule:
            entry.accessKind === "noGuests"
              ? "Alle außer Gästen"
              : entry.accessKind === "resources"
                ? "Ressourcenberechtigungen"
                : "Alle angemeldeten Personen",
          editor:
            entry.accessKind === "grants"
              ? { app: { id: entry.id, name: entry.name, access: { kind: "grants" as const } }, repair: true, initial: undefined }
              : null,
        } as const;
      if (view === "keys")
        return {
          view,
          keys: {
            app: { id: entry.id, name: entry.name },
            neverStarted: entry.neverStarted,
            initialKeys: state === "keys-error" ? null : keys,
            people: { [ADMIN_ID]: "Alex Berger" },
            accountStatus: state === "keys-off" ? ("disabled" as const) : ("active" as const),
            tokens: {
              items: entry.neverStarted
                ? []
                : [
                    {
                      id: "55555555-5555-4555-8555-555555555555",
                      name: "host-override",
                      tokenPrefix: "cst_7f3k",
                      status: "active" as const,
                      expiresAt: "2026-12-31T23:00:00.000Z",
                      lastUsedAt: "2026-10-27T10:00:00.000Z",
                    },
                  ],
              total: entry.neverStarted ? 0 : 1,
              hasNext: false,
            },
            docsHref: "/docs/en/operations/app-keys",
            timeZone: "Europe/Berlin",
          },
        } as const;
      if (view === "events") return details ? ({ view } as const) : null;
      if (view === "routes") {
        const traffic = entry.numbers[0]?.traffic;
        const down = state === "provider";
        return {
          view,
          window: query.window,
          rows: entry.routes.map((prefix, index) => {
            const missing = entry.missingRoutes.find((route) => route.prefix === prefix);
            const share = [0.73, 0.25, 0.012, 0.008][index] ?? 0.01;
            return {
              prefix,
              requests: down || missing || !traffic ? null : Math.round(traffic.requests * share),
              errors: down || missing || !traffic ? null : Math.round(traffic.errors * (index === 1 ? 0.6 : 0.4)),
              router: missing ? ("missing" as const) : state === "router-unknown" ? ("unknown" as const) : ("active" as const),
              owner: missing?.owner ?? null,
            };
          }),
          providers: down ? [] : ["Gateway"],
          failures: down ? ["Gateway"] : [],
          routerKnown: state !== "router-unknown",
          avgMs: down ? null : (traffic?.avgMs ?? null),
          telemetryHref: "/admin/observability/telemetry?app=" + entry.id,
          routesHref: "/admin/observability/gateway/routes",
        } as const;
      }
      if (view === "runtime")
        return {
          view,
          release: entry.release,
          build: "7f3c2a1",
          sync: entry.id === "grids" ? "6.3.2" : "6.4.0",
          baseUrl: `http://app-${entry.id}:3000`,
          heartbeatAt: new Date(FIXTURE_NOW - 8000).toISOString(),
          startedAt: "2026-10-27T08:14:00.000Z",
          issues:
            entry.id === "grids"
              ? [
                  {
                    severity: "warn" as const,
                    message:
                      "Sync-Version weicht ab: Grids nutzt 6.3.2, die anderen Apps 6.4.0. Aktualisiere Grids auf die Cloud-Version der anderen.",
                  },
                ]
              : [],
          instances: [
            { hostname: `app-${entry.id}-7c9d`, startedAt: "2026-10-27T08:14:00.000Z", via: "key" as const, keyName: "produktion-2026-10" },
            { hostname: `app-${entry.id}-k2p1`, startedAt: "2026-10-27T08:15:00.000Z", via: "unknown" as const, keyName: null },
          ],
          inRail: true,
          adminHref: entry.adminHref,
          capabilities: 4,
          capabilitiesHref: "/admin/observability/capabilities?app=" + entry.id,
        } as const;
      return {
        view,
        failedRequests:
          entry.id === "grids"
            ? [
                ["12:58:12", "POST", "/api/grids/rows", 500],
                ["12:41:03", "POST", "/api/grids/rows", 500],
                ["12:12:47", "GET", "/api/grids/export", 504],
                ["11:55:30", "PATCH", "/api/grids/rows", 500],
                ["11:40:02", "POST", "/api/grids/rows", 500],
              ].map(([time, method, path, status]) => ({
                at: `2026-10-30T${time}.000Z`,
                method: String(method),
                path: String(path),
                status: Number(status),
              }))
            : [],
        total: entry.id === "grids" ? 18 : 0,
        providers: ["Gateway"],
        failures: [],
        telemetryHref: "/admin/observability/telemetry?app=" + entry.id,
        logsHref: "/admin/observability/logs",
      } as const;
    })();
    const body = renderToString(() =>
      createComponent(AdminLayout, {
        c,
        title: entry?.name ?? "Apps",
        ownMain: true,
        get children() {
          return createComponent(AppsView, {
            data: {
              locale,
              format,
              query,
              list:
                state === "failed"
                  ? { state: "failed" }
                  : {
                      state: "ok",
                      apps: state === "empty" ? [] : apps,
                      issues: state === "rejected" ? [{ key: "apps/maps", reason: "routes fehlt" }] : [],
                      unchecked: 0,
                      logsHref: "/admin/observability/logs",
                    },
              app: entry
                ? {
                    entry,
                    details,
                    revokedKeyName: keys.find((item) => item.status === "revoked")?.name ?? null,
                    providerFailures: state === "provider" ? ["Gateway"] : [],
                    appNames: new Map([
                      ["contacts", "Kontakte"],
                      ["files", "Dateien"],
                      ["core", "Core"],
                    ]),
                  }
                : null,
              detail,
            },
          });
        },
      }),
    );
    return c.html(
      `<!doctype html><html lang="${locale}" class="${theme}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui">${body}<script src="/fixture.js"></script></body></html>`,
    );
  });

  const api = async (request: Request, url: URL): Promise<Response> => {
    const state = (new URL(request.headers.get("referer") ?? "http://x/").searchParams.get("state") ?? "normal") as AdminAppsFixtureState;
    if (state === "slow") await Bun.sleep(1500);
    const listing = url.pathname.match(/^\/api\/admin\/apps\/([^/]+)\/listing$/);
    if (listing && request.method === "DELETE") {
      if (state === "core-fail") return Response.json({ code: "forget_failed" }, { status: 502 });
      removed.add(listing[1]!);
      return Response.json({ removed: true });
    }
    const status = url.pathname.match(/^\/api\/admin\/apps\/([^/]+)\/status$/);
    if (status) return Response.json({ traffic: "12.400 · 0,2 % Fehler · 48 ms", errors: "24 in 24 h", unavailable: false });
    const keyList = url.pathname.match(/^\/api\/admin\/apps\/([^/]+)\/keys$/);
    if (keyList && request.method === "GET") {
      if (state === "keys-error") return Response.json({ message: "unavailable" }, { status: 503 });
      return Response.json({
        installationId: "66666666-6666-4666-8666-666666666666",
        items: fixtureKeys(keyList[1]!),
        page: 1,
        perPage: 100,
        total: 2,
        hasNext: false,
      });
    }
    if (keyList && request.method === "POST")
      return Response.json({
        keyId: "77777777-7777-4777-8777-777777777777",
        installationId: "66666666-6666-4666-8666-666666666666",
        fingerprint: "3f9ac21e77b05d14e8a2c6b09d31f7a4",
        status: "active",
        accountStatus: "active",
      });
    if (/^\/api\/admin\/apps\/[^/]+\/keys\/[^/]+$/.test(url.pathname) && request.method === "DELETE") return Response.json(null);
    if (/^\/api\/admin\/identity\/workloads\/[^/]+\/credentials$/.test(url.pathname) && request.method === "GET")
      return Response.json({ items: [], page: 1, perPage: 20, total: 0, hasNext: false });
    return Response.json({ message: "Synthetic fixture: not available" }, { status: 503 });
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname.startsWith("/public/")) {
        const path = resolve(root, `.${url.pathname}`);
        return path.startsWith(`${publicDir}/`) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
      }
      if (url.pathname.startsWith("/api/")) return api(request, url);
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/admin/apps`,
    reset() {
      removed = new Set();
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const fixture = await adminAppsBrowserFixture({ port: Number(Bun.argv[2] ?? 0) });
  console.log(fixture.url);
}
