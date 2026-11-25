/** Synthetic admin authority and mail data; the real AdminLayout, the v2 section screens and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AdminMailApp, AdminMailProfile, AdminMailRecord, CloudRuntime, User } from "@k2b/cloud/contracts";
import tailwind from "bun-plugin-tailwind";
import { type Context, Hono } from "hono";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";

const profile = (key: string, name: string, extra: Partial<AdminMailProfile> = {}): AdminMailProfile => ({
  key,
  name,
  fromAddress: `${key}@example.test`,
  fromName: null,
  smtpHost: "smtp.example.test",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: "cloud",
  hasPassword: true,
  pacePerMinute: 60,
  dailyRecipientLimit: null,
  maxAttachmentBytes: 15 * 1024 * 1024,
  imap: null,
  bounces: null,
  isDefault: false,
  revision: 3,
  createdAt: "2026-10-01T08:00:00.000Z",
  updatedAt: "2026-10-01T08:00:00.000Z",
  updatedBy: null,
  appCount: 2,
  ...extra,
});
const app = (appId: string, name: string, extra: Partial<AdminMailApp> = {}): AdminMailApp => ({
  appId,
  name,
  registered: true,
  declared: true,
  readDeclared: false,
  mode: "default",
  profiles: [],
  logApps: [],
  ...extra,
});
const record = (id: string, subject: string, extra: Partial<AdminMailRecord> = {}): AdminMailRecord => ({
  id,
  appId: "invoices",
  profile: "system",
  to: ["kunde@example.test"],
  subject,
  status: "sent",
  attempts: 1,
  createdAt: "2026-11-24T08:00:00.000Z",
  sentAt: "2026-11-24T08:00:05.000Z",
  failures: [],
  attachments: [],
  ...extra,
});

/** The starting data; each page load starts again from it. */
export const outgoingMailStart = () => ({
  profiles: [profile("system", "System", { isDefault: true }), profile("newsletter", "Newsletter", { fromName: "Rundbrief" })],
  apps: [
    app("backoffice", "Backoffice", {
      declared: false,
      readDeclared: true,
      logApps: ["invoices", "legacy-crm"],
      logContentApps: ["invoices"],
    }),
    app("invoices", "Invoices"),
    app("core", "Cloud"),
  ],
  messages: [
    record("aaaaaaaa-0000-4000-8000-000000000001", "Rechnung 2026-114"),
    record("aaaaaaaa-0000-4000-8000-000000000002", "Mahnung 2026-099", {
      status: "queued",
      sentAt: undefined,
      batchId: "bbbbbbbb-0000-4000-8000-000000000001",
    }),
    record("aaaaaaaa-0000-4000-8000-000000000003", "Zustellung fehlgeschlagen", {
      appId: "backoffice",
      status: "failed",
      error: "550 mailbox unavailable",
    }),
  ],
  retention: { contentDays: 30, recordDays: 365 },
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

export async function outgoingMailBrowserFixture() {
  const root = mkdtempSync(join(tmpdir(), "core-outgoing-mail-v2-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  registerSsrTestPlugin({ dev: true, rootDir: root });
  const { AdminLayout } = await import("@k2b/cloud/ssr");
  const { default: ProfilesScreen } = await import("./ProfilesScreen");
  const { default: AppsScreen } = await import("./AppsScreen");
  const { default: LogScreen } = await import("./LogScreen");
  const { logQuery, parseLogAddress } = await import("./log-query");
  const { adminNavFixture } = await import("../admin-v2.fixture");
  const ui = resolve(import.meta.dir, "../../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "OutgoingMail.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-outgoing-mail-fixture",
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
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the outgoing mail screens");
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

  let data = outgoingMailStart();
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
  /** The page as the server sends it: the real AdminLayout around one section screen, its props for the harness. */
  const respond = (c: Context<{ Variables: Variables }>, screen: string, props: object, view: () => JSX.Element) => {
    const body = renderToString(() =>
      createComponent(AdminLayout, {
        c,
        ui: "v2",
        title: "Outgoing mail",
        get children() {
          return view();
        },
      }),
    );
    return c.html(
      `<!doctype html><html lang="${localeOf(c)}" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui">${body}<script type="application/json" id="screen-props" data-screen="${screen}">${JSON.stringify(props).replaceAll("<", "\\u003c")}</script><script src="/fixture.js"></script></body></html>`,
    );
  };
  const localeOf = (c: Context<{ Variables: Variables }>) => (new URL(c.req.url).searchParams.get("locale") === "en" ? "en" : "de");
  pages.use("*", async (c, next) => {
    const locale = localeOf(c);
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", { apps: [{ id: "core", name: "Cloud", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] }] });
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    c.set("page", { title: "Outgoing mail", theme: "light" });
    await next();
  });
  const nav = adminNavFixture("/admin/outgoing-mail");
  pages.get("/admin/outgoing-mail", (c) => {
    const props = {
      nav,
      profiles: data.profiles.map((item) => ({ ...item, bounceText: "Bounce check off", bounceFailed: false })),
      open: c.req.query("profile") ?? null,
    };
    return respond(c, "profiles", props, () => createComponent(ProfilesScreen, props));
  });
  pages.get("/admin/outgoing-mail/apps", (c) => {
    const props = { nav, profiles: data.profiles, apps: data.apps, open: c.req.query("app") ?? null };
    return respond(c, "apps", props, () => createComponent(AppsScreen, props));
  });
  pages.get("/admin/outgoing-mail/log", (c) => {
    const apps = data.apps.map((item) => ({ appId: item.appId, name: item.name }));
    const params = new URL(c.req.url).searchParams;
    params.delete("locale");
    const address = parseLogAddress(logQuery(localeOf(c), apps), params);
    const props = {
      nav,
      apps,
      state: address.state,
      page: { items: data.messages, page: 1, perPage: 25, total: data.messages.length, hasNext: false },
      retention: data.retention,
      message: data.messages.find((item) => item.id === address.message) ?? null,
      timeZone: "Europe/Berlin",
    };
    return respond(c, "log", props, () => createComponent(LogScreen, props));
  });

  const api = new Hono().basePath("/api/admin/core/outgoing-mail");
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
  api.put("/profiles/:key", async (c) => {
    const body = (await c.req.json()) as Partial<AdminMailProfile>;
    if (body.name === "Fehler") return c.json({ code: "revision_conflict", message: "conflict" }, 409);
    const key = c.req.param("key");
    const known = data.profiles.find((item) => item.key === key);
    const next = { ...(known ?? profile(key, body.name ?? key)), ...body, key, revision: (known?.revision ?? 0) + 1 } as AdminMailProfile;
    data = { ...data, profiles: known ? data.profiles.map((item) => (item.key === key ? next : item)) : [...data.profiles, next] };
    return c.json(next);
  });
  api.post("/profiles/:key/test", (c) => c.json({ ok: true }));
  api.post("/profiles/:key/default", (c) => {
    data = { ...data, profiles: data.profiles.map((item) => ({ ...item, isDefault: item.key === c.req.param("key") })) };
    return c.json({ ok: true });
  });
  api.delete("/profiles/:key", (c) => {
    data = { ...data, profiles: data.profiles.filter((item) => item.key !== c.req.param("key")) };
    return c.json({ ok: true });
  });
  api.put("/apps/:appId", (c) => c.json({ ok: true }));
  // A refused log grant answers in the reader's words.
  api.put("/apps/:appId/log-access", (c) =>
    c.req.param("appId") === "backoffice" ? c.json({ code: "invalid_profile", message: "Synthetic rejection" }, 400) : c.json({ ok: true }),
  );
  api.get("/messages", (c) => c.json({ items: data.messages.filter((item) => !c.req.query("app") || item.appId === c.req.query("app")) }));
  api.get("/messages/:id/content", (c) => c.json({ purged: false, text: "Guten Tag, anbei Ihre Rechnung.", html: null }));
  api.post("/messages/:id/cancel", (c) => {
    const id = c.req.param("id");
    data = { ...data, messages: data.messages.map((item) => (item.id === id ? { ...item, status: "cancelled" as const } : item)) };
    return c.json(data.messages.find((item) => item.id === id));
  });
  api.put("/retention", async (c) => {
    const body = (await c.req.json()) as { contentDays?: number; recordDays?: number };
    data = { ...data, retention: { ...data.retention, ...body } };
    return c.json(data.retention);
  });

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
      if (url.pathname.startsWith("/api/admin/core/outgoing-mail")) return api.fetch(request);
      if (url.pathname.startsWith("/api/")) return Response.json({ message: "Synthetic fixture: service unavailable" }, { status: 503 });
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    reset() {
      data = outgoingMailStart();
      requests.length = 0;
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
