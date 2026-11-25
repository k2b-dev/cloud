/** Synthetic admin data for the overview, announcements and navigation on v2; the real AdminLayout and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AnnouncementEntry, CloudRuntime, RailAdminState, User } from "@k2b/cloud/contracts";
import tailwind from "bun-plugin-tailwind";
import { type Context, Hono } from "hono";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const announcement = (id: string, title: string, extra: Partial<AnnouncementEntry> = {}): AnnouncementEntry => ({
  id,
  version: 1,
  kind: "announcement",
  title,
  body: "Ab Montag gilt die neue Anmeldung für alle.",
  tone: "info",
  publishedAt: "2026-11-20T08:00:00.000Z",
  expiresAt: null,
  createdAt: "2026-11-20T08:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
  createdBy: null,
  updatedBy: null,
  ...extra,
});

/** The starting data; each page load starts again from it. */
const start = (): { announcements: AnnouncementEntry[]; rail: RailAdminState } => ({
  announcements: [
    announcement("aaaaaaaa-0000-4000-8000-000000000001", "Neue Anmeldung ab Montag"),
    announcement("aaaaaaaa-0000-4000-8000-000000000002", "Wartung am Samstag", { kind: "banner", tone: "warning" }),
  ],
  rail: {
    revision: 4,
    entries: [
      {
        shortcut: {
          id: "bbbbbbbb-0000-4000-8000-000000000001",
          kind: "link",
          title: "Handbuch",
          href: "https://docs.example.test",
          icon: "ti ti-book",
        },
        access: [
          {
            id: "cccccccc-0000-4000-8000-000000000001",
            principal: { type: "authenticated" },
            permission: "read",
            createdAt: "2026-11-01T08:00:00.000Z",
          },
        ],
      },
      { shortcut: { id: "bbbbbbbb-0000-4000-8000-000000000002", kind: "app", appId: "mail" }, access: [] },
    ],
  },
});

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

export async function adminV2BrowserFixture() {
  const root = mkdtempSync(join(tmpdir(), "core-admin-v2-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  registerSsrTestPlugin({ dev: true, rootDir: root });
  const { AdminLayout } = await import("@k2b/cloud/ssr");
  const { default: OverviewScreen } = await import("./OverviewScreen");
  const { default: AnnouncementsScreen } = await import("./announcements/AnnouncementsScreen");
  const { default: NavigationScreen } = await import("./rail/NavigationScreen");
  const { adminNavFixture } = await import("./admin-v2.fixture");
  const ui = resolve(import.meta.dir, "../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "admin-v2.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-admin-v2-fixture",
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
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the admin v2 screens");
  const script = await bundle.outputs[0]!.text();
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
  const publicDir = join(root, "public");
  await (await import("../../../scripts/font-assets")).buildFontAssets(publicDir);
  await (await import("../../../scripts/tabler-assets")).buildTablerIconAssets(publicDir);

  let data = start();
  const requests: { method: string; path: string; body: unknown }[] = [];
  type Variables = {
    runtime: CloudRuntime;
    user: User;
    settings: Record<string, unknown>;
    actor: undefined;
    panelConsent: undefined;
    railPreferences: undefined;
    announcements: undefined;
    page: { title?: string; theme: "light" };
  };
  const pages = new Hono<{ Variables: Variables }>();
  const localeOf = (c: Context<{ Variables: Variables }>) => (new URL(c.req.url).searchParams.get("locale") === "en" ? "en" : "de");
  pages.use("*", async (c, next) => {
    const locale = localeOf(c);
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", { apps: [{ id: "core", name: "Cloud", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] }] });
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    c.set("page", { title: "Administration", theme: "light" });
    await next();
  });
  const respond = (c: Context<{ Variables: Variables }>, screen: string, props: object, view: () => JSX.Element) => {
    const body = renderToString(() =>
      createComponent(AdminLayout, {
        c,
        ui: "v2",
        title: "Administration",
        get children() {
          return view();
        },
      }),
    );
    return c.html(
      `<!doctype html><html lang="${localeOf(c)}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui">${body}<script type="application/json" id="screen-props" data-screen="${screen}">${JSON.stringify(props).replaceAll("<", "\\u003c")}</script><script src="/fixture.js"></script></body></html>`,
    );
  };
  pages.get("/admin", (c) => {
    const task = (href: string, title: string, description: string, icon: string) => ({ href, title, description, icon });
    const props = {
      nav: adminNavFixture("/admin"),
      title: "Administration",
      lead: "14 registrierte Dienste",
      facts: ["3 App-Verwaltungsbereiche"],
      sections: [
        {
          title: "Hier starten",
          summary: "Wähle, was du erledigen willst.",
          tasks: [
            task(
              "/admin/observability",
              "System untersuchen",
              "Beginne mit aktiven Signalen, dann Anfragen, Jobs und Protokolle.",
              "stethoscope",
            ),
            task("/admin/apps", "Apps und Routen", "Registrierte Dienste und wem welche Route gehört.", "route-scan"),
            task("/admin/signin", "Personen und Zugriff", "Konten, Rollen, Gruppen und ihr Lebenszyklus.", "users"),
          ],
        },
        {
          title: "Plattform",
          summary: "Einstellungen der Instanz nach Aufgabe.",
          tasks: [
            task("/admin/base", "Grundeinstellungen", "Name, Sprache, Startseite und Verhalten der Instanz.", "app-window"),
            task("/admin/storage", "Speicher", "Garage-Verbindung und Größengrenze für Apps.", "database"),
            task("/admin/outgoing-mail", "Ausgehende Mail", "Absenderprofile und welche App senden darf.", "mail"),
          ],
        },
        {
          title: "App-Verwaltung",
          summary: "Einstellungen, die Apps selbst mitbringen.",
          tasks: [task("/admin/mail", "Mail", "Postfächer und Weiterleitungen.", "mail")],
        },
      ],
    };
    return respond(c, "overview", props, () => createComponent(OverviewScreen, props));
  });
  pages.get("/admin/announcements", (c) => {
    const rows = data.announcements.map((entry) => ({
      ...entry,
      state: "active" as const,
      published: "20.11.2026, 09:00",
      expires: "Kein Ablauf",
    }));
    const requested = c.req.query("entry") ?? null;
    const props = {
      nav: adminNavFixture("/admin/announcements"),
      rows,
      open: requested === "new" || rows.some((row) => row.id === requested) ? requested : null,
    };
    return respond(c, "announcements", props, () => createComponent(AnnouncementsScreen, props));
  });
  pages.get("/admin/apps/navigation", (c) => {
    const requested = c.req.query("shortcut") ?? null;
    const props = {
      nav: adminNavFixture("/admin/apps"),
      initial: data.rail,
      apps: [{ id: "mail", label: "Mail", icon: "ti ti-mail" }],
      open: requested === "new" || data.rail.entries.some((entry) => entry.shortcut.id === requested) ? requested : null,
    };
    return respond(c, "navigation", props, () => createComponent(NavigationScreen, props));
  });

  const api = new Hono().basePath("/api/admin/core");
  api.use(async (c, next) => {
    requests.push({
      method: c.req.method,
      path: c.req.path,
      body:
        c.req.method === "GET"
          ? undefined
          : await c.req.raw
              .clone()
              .json()
              .catch(() => undefined),
    });
    await next();
  });
  api.post("/announcements", async (c) => {
    const body = (await c.req.json()) as Partial<AnnouncementEntry>;
    const created = announcement("aaaaaaaa-0000-4000-8000-000000000009", body.title ?? "", body);
    data = { ...data, announcements: [...data.announcements, created] };
    return c.json(created, 201);
  });
  api.patch("/announcements/:id", async (c) => {
    const body = (await c.req.json()) as Partial<AnnouncementEntry>;
    data = { ...data, announcements: data.announcements.map((item) => (item.id === c.req.param("id") ? { ...item, ...body } : item)) };
    return c.json(data.announcements.find((item) => item.id === c.req.param("id")));
  });
  api.delete("/announcements/:id", (c) => {
    data = { ...data, announcements: data.announcements.filter((item) => item.id !== c.req.param("id")) };
    return c.body(null, 204);
  });
  api.delete("/announcements/cache", (c) => c.json({ success: true }));
  api.put("/rail", async (c) => {
    const body = (await c.req.json()) as RailAdminState;
    if (body.revision !== data.rail.revision) return c.json({ message: "conflict" }, 409);
    data = { ...data, rail: { ...body, revision: body.revision + 1 } };
    return c.json(data.rail);
  });
  api.delete("/rail/cache", (c) => c.json({ success: true }));

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname.startsWith("/public/")) {
        const path = resolve(root, `.${url.pathname}`);
        return path.startsWith(`${publicDir}/`) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
      }
      if (url.pathname.startsWith("/api/admin/core")) return api.fetch(request);
      if (url.pathname.startsWith("/api/")) return Response.json({ message: "Synthetic fixture: service unavailable" }, { status: 503 });
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    reset() {
      data = start();
      requests.length = 0;
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
