/** Synthetic admin and maintenance data; real AdminLayout, page island and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import { MaintenanceOnInputSchema, type MaintenanceStatus, MaintenanceUntilInputSchema } from "@k2b/cloud/contracts/maintenance";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";

const PATH = "/admin/settings/maintenance";
/** The clock the browser test sets: 14:10 in Berlin, so the mockup's 14:02 and 14:30 read as today. */
export const MAINTENANCE_FIXTURE_NOW = new Date("2026-11-16T13:10:00.000Z");

/** A page init script that pins only `Date` to `at`; timers keep running, so the page polls and animates as usual. */
export const pinPageClock = (at: number) => {
  const RealDate = Date;
  const offset = at - RealDate.now(); // real clock: the page's distance to the pinned instant
  class PinnedDate extends RealDate {
    constructor(...args: ConstructorParameters<DateConstructor> | []) {
      if (args.length === 0)
        super(RealDate.now() + offset); // real clock: flows from the pinned instant
      else super(...(args as ConstructorParameters<DateConstructor>));
    }
    static override now() {
      return RealDate.now() + offset; // real clock: flows from the pinned instant
    }
  }
  globalThis.Date = PinnedDate as DateConstructor;
};

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "lea.muster",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Lea",
  sn: "Muster",
  displayName: "Lea Muster",
  mail: "lea.muster@example.test",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};
const appNames = { files: "Dateien", mail: "Mail" };
const running = (): MaintenanceStatus => ({
  active: true,
  startedAt: "2026-11-16T13:02:00.000Z",
  startedBy: { id: user.id, label: "Lea Muster" },
  message: "Wir spielen Version 2.4 ein. Danach ist alles wie vorher.",
  until: "2026-11-16T13:30:00.000Z",
  apps: { ready: 9, total: 11, starting: ["files", "mail"] },
});

/** Named starting points; the start, move and end flows are reached by interaction. */
export const MAINTENANCE_SCENARIOS = {
  aus: (): MaintenanceStatus => ({ active: false, apps: { ready: 11, total: 11, starting: [] } }),
  aktiv: running,
  "aktiv-knapp": (): MaintenanceStatus => ({
    active: true,
    startedAt: "2026-11-16T13:02:00.000Z",
    startedBy: { id: user.id, label: "Lea Muster" },
    apps: { ready: 11, total: 11, starting: [] },
  }),
} satisfies Record<string, () => MaintenanceStatus>;
export type MaintenanceScenario = keyof typeof MAINTENANCE_SCENARIOS;

export async function maintenanceBrowserFixture() {
  const root = mkdtempSync(join(tmpdir(), "core-maintenance-host-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
  const { AdminLayout } = await import("@k2b/cloud/ssr");
  const { default: Maintenance } = await import("./Maintenance.island.tsx");
  const { maintenanceAdminMessages } = await import("./messages");
  const ui = resolve(import.meta.dir, "../../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "Maintenance.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-maintenance-fixture",
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
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the maintenance page");
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

  // The synthetic Core and gateway: one state, reset when a page names a scenario.
  let state: MaintenanceStatus = MAINTENANCE_SCENARIOS.aus();
  const control = { failOn: false, failBypass: false, requests: [] as Array<{ method: string; path: string; body: string }> };

  const api = new Hono()
    .use(async (c, next) => {
      control.requests.push({ method: c.req.method, path: c.req.path, body: c.req.method === "GET" ? "" : await c.req.raw.clone().text() });
      await next();
    })
    .get("/api/admin/maintenance", (c) => c.json(state))
    .post("/api/admin/maintenance/on", async (c) => {
      if (control.failOn) return c.json({ code: "INTERNAL", message: "Synthetic outage" }, 500);
      const input = MaintenanceOnInputSchema.parse(await c.req.json());
      state = {
        active: true,
        startedAt: MAINTENANCE_FIXTURE_NOW.toISOString(),
        startedBy: { id: user.id, label: "Lea Muster" },
        ...(input.message ? { message: input.message } : {}),
        ...(input.until ? { until: input.until } : {}),
        apps: running().apps,
      };
      return c.json(state);
    })
    .post("/api/admin/maintenance/until", async (c) => {
      state = { ...state, until: MaintenanceUntilInputSchema.parse(await c.req.json()).until };
      return c.json(state);
    })
    .post("/api/admin/maintenance/bypass", (c) =>
      control.failBypass
        ? c.json({ code: "INTERNAL", message: "Synthetic outage" }, 500)
        : c.json({ url: `${new URL(c.req.url).origin}/?cloud-maintenance-bypass=fixture`, expiresAt: "2026-11-17T01:10:00.000Z" }),
    )
    .post("/api/admin/maintenance/off", (c) => {
      state = MAINTENANCE_SCENARIOS.aus();
      return c.json(state);
    })
    .all("/api/*", (c) => c.json({ message: "Synthetic fixture: unknown route" }, 404));

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
  pages.get(PATH, (c) => {
    const locale = c.req.query("locale") === "en" ? "en" : "de";
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const scenario = Object.entries(MAINTENANCE_SCENARIOS).find(([name]) => name === c.req.query("state"));
    if (scenario) state = scenario[1]();
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", { apps: [{ id: "core", name: "Core", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] }] });
    c.set("user", user);
    c.set("settings", { app: { name: "Musterverein Cloud", locale } });
    const title = maintenanceAdminMessages.resolve([locale]).t.title;
    c.set("page", { title, theme });
    const props = { initial: state, appNames, dateConfig: { timeZone: "Europe/Berlin", locale, firstDayOfWeek: 1 as const }, path: PATH };
    const body = renderToString(() =>
      createComponent(AdminLayout, {
        c,
        title,
        get children() {
          return createComponent(Dynamic, {
            component: "div",
            class: "app-rows",
            id: "maintenance-fixture",
            get children() {
              return createComponent(Maintenance, props);
            },
          });
        },
      }),
    );
    return c.html(
      `<!doctype html><html lang="${locale}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}">${body}<script type="application/json" id="maintenance-fixture-data">${JSON.stringify(props).replace(/</g, "\\u003c")}</script><script src="/fixture.js"></script></body></html>`,
    );
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/branding/logo")
        return new Response(Bun.file(resolve(import.meta.dir, "../../../../../cloud/public/logo.svg")));
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname.startsWith("/public/")) {
        const path = resolve(root, `.${url.pathname}`);
        return path.startsWith(`${publicDir}/`) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
      }
      // The gateway's half: the status it answers from memory, and a bypass link it turns into a redirect.
      if (url.pathname === "/_cloud/gateway/status")
        return Response.json({ maintenance: state.active ? { active: true, until: null } : null });
      if (url.searchParams.has("cloud-maintenance-bypass")) {
        url.searchParams.delete("cloud-maintenance-bypass");
        return new Response(null, { status: 303, headers: { Location: `${url.pathname}${url.search}` } });
      }
      if (url.pathname.startsWith("/api/")) return api.fetch(request);
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}${PATH}`,
    control,
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
