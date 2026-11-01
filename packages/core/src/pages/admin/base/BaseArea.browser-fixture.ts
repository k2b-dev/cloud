/** Synthetic admin and settings; the real AdminLayout, Base settings area, registry form islands and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import { createConfig } from "@k2b/ssr";
import { type Context, Hono } from "hono";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { SettingFieldDef } from "../settings/_components/setting-field";

/** States the captures and tests switch with `?state=`. */
export type BaseFixtureState = "normal" | "conflict" | "conflictgone" | "unreadable" | "savefail";

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

const entry = (
  group: string,
  key: string,
  kind: SettingFieldDef["kind"],
  value: unknown,
  extra: Partial<SettingFieldDef> = {},
): SettingFieldDef => ({
  key,
  label: key,
  description: "",
  kind,
  value,
  default: value,
  resetValue: value,
  valueSource: "custom",
  resetValueSource: "default",
  isCustom: true,
  unreadable: false,
  group,
  updatedAt: "2026-10-27T08:00:00.000Z",
  updatedBy: null,
  ...extra,
});

export const fixtureEntries = (state: BaseFixtureState): SettingFieldDef[] => [
  entry("app", "app.name", "string", "Beispiel Cloud", {
    label: "Name",
    description: "Shown in the browser tab, in mails and on the sign-in page.",
  }),
  entry("app", "app.logo", "image", ""),
  entry("app", "app.favicon", "image", ""),
  entry("app", "app.locale", "enum", "de", {
    label: "Language for new people",
    options: [
      { value: "de", label: "Deutsch" },
      { value: "en", label: "English" },
    ],
  }),
  entry("app", "app.timezone", "timezone", "Europe/Berlin", {
    label: "Time zone",
    unreadable: state === "unreadable",
    valueSource: state === "unreadable" ? "default" : "custom",
  }),
  entry("app", "app.url", "url", "https://cloud.example.org", { label: "Address" }),
  entry("app", "app.home_path", "string", "/", { label: "Start page" }),
  entry("app", "app.contact_email", "email", "it@example.org", { label: "Contact address" }),
  entry("app", "app.copyright", "string", "© 2026 Beispiel GmbH", { label: "Copyright" }),
  entry("app", "app.documentation_url", "url", "https://docs.example.org", { label: "Documentation website" }),
  entry("app", "app.cleanup_schedule", "cron", "0 3 * * *", { label: "Cleanup schedule", isCustom: false, valueSource: "default" }),
  entry("gotenberg", "gotenberg.url", "url", "http://gotenberg:3000", { label: "Gotenberg address" }),
  entry("gotenberg", "gotenberg.username", "string", "", { label: "User name" }),
  entry("gotenberg", "gotenberg.password", "secret", "", { label: "Password" }),
  entry("gotenberg", "gotenberg.timeout_ms", "number", 30000, { label: "Timeout (ms)", min: 1000, max: 120000 }),
  entry("gotenberg", "gotenberg.max_html_bytes", "number", 5000000, { label: "Largest page (bytes)" }),
  entry("gotenberg", "gotenberg.max_pdf_bytes", "number", 20000000, { label: "Largest PDF (bytes)" }),
  entry("user", "user.category.guest.enabled", "boolean", false, { label: "Guest accounts" }),
  entry("user", "user.category.guest.visible", "boolean", true, { label: "Show guest sign-in" }),
  entry("user", "user.category.login.enabled", "boolean", true, { label: "Login accounts" }),
  entry("user", "user.category.login.label", "string", "Login", { label: "Name of the login option" }),
  entry("user", "user.category.login.visible", "boolean", true, { label: "Show login sign-in" }),
  entry("user", "user.category.freeipa.enabled", "boolean", true, { label: "FreeIPA accounts" }),
  entry("user", "user.category.freeipa.visible", "boolean", true, { label: "Show FreeIPA sign-in" }),
  entry("user", "user.session.expiry_hours", "number", 24, { label: "Session length (hours)" }),
  entry("freeipa", "freeipa.enable", "boolean", true, { label: "Use FreeIPA" }),
  entry("freeipa", "freeipa.url", "url", "https://ipa.example.org", { label: "FreeIPA address" }),
  entry("freeipa", "freeipa.service_user", "string", "cloud-sync", { label: "Service user" }),
  entry("freeipa", "freeipa.service_password", "secret", "", { label: "Service password" }),
];

const ui = new URL("../../../../../ui/", import.meta.url).pathname;
const uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));

export async function baseAreaBrowserFixture(options: { port?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "core-base-area-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
  const { BaseFormView } = await import("./view");
  const { generalSections, pdfSections } = await import("./sections");
  const { SigninFormView } = await import("../signin/view");
  const { freeipaSections, signinSections } = await import("../signin/sections");

  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "BaseArea.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-base-area-fixture",
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
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the Base area islands");
  const script = await bundle.outputs[0]!.text();
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../../cloud/", import.meta.url).pathname)))
    .default;
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
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  const fontCss =
    (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/fonts/") +
    icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/tabler-icons.woff2");
  const iconFile = resolve(uiDist, /tabler-icons-[\w-]+\.woff2/.exec(icons)![0]);

  let stored = fixtureEntries("normal");
  let saves = 0;
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
  const render = (section: "general" | "pdf", groups: string[]) => (c: Context<{ Variables: Variables }>) => {
    const url = new URL(c.req.url);
    const locale = url.searchParams.get("locale") === "en" ? "en" : "de";
    const state = (url.searchParams.get("state") ?? "normal") as BaseFixtureState;
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", { apps: [{ id: "core", name: "Core", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] }] });
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    c.set("page", { title: "Base settings", theme: "light" });
    const entries = (state === "normal" ? stored : fixtureEntries(state)).filter((item) => groups.includes(item.group));
    const sections = section === "general" ? generalSections(locale) : pdfSections(locale);
    const body = renderToString(() => createComponent(BaseFormView, { c, locale, section, groups, sections, entries }));
    return c.html(
      `<!doctype html><html lang="${locale}" class="light" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fonts.css"><style>${css}</style></head><body class="k2b-ui">${body}<script src="/fixture.js"></script></body></html>`,
    );
  };
  const renderSignin = (section: "signin" | "freeipa", group: string) => (c: Context<{ Variables: Variables }>) => {
    const url = new URL(c.req.url);
    const locale = url.searchParams.get("locale") === "en" ? "en" : "de";
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", { apps: [{ id: "core", name: "Core", description: "Platform", icon: "ti ti-cloud", routes: ["/admin", "/"] }] });
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    c.set("page", { title: "Sign-in & security", theme: "light" });
    const sections = section === "signin" ? signinSections(locale) : freeipaSections(locale);
    const keys = new Set(sections.flatMap((item) => item.keys));
    const entries = stored.filter((item) => item.group === group && keys.has(item.key));
    const body = renderToString(() => createComponent(SigninFormView, { c, locale, section, groups: [group], sections, entries }));
    return c.html(
      `<!doctype html><html lang="${locale}" class="light" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fonts.css"><style>${css}</style></head><body class="k2b-ui">${body}<script src="/fixture.js"></script></body></html>`,
    );
  };
  pages.get("/admin/signin", renderSignin("signin", "user"));
  pages.get("/admin/signin/freeipa", renderSignin("freeipa", "freeipa"));
  pages.get("/admin/base", render("general", ["app"]));
  pages.get("/admin/base/pdf", render("pdf", ["gotenberg"]));

  const stateOf = (request: Request) =>
    (new URL(request.headers.get("referer") ?? "http://x/").searchParams.get("state") ?? "normal") as BaseFixtureState;
  const api = async (request: Request, url: URL): Promise<Response> => {
    const state = stateOf(request);
    if (url.pathname === "/api/admin/core/settings/entries") {
      const group = url.searchParams.get("group");
      return Response.json({ items: stored.filter((item) => item.group === group) });
    }
    if (url.pathname === "/api/admin/core/settings" && request.method === "PUT") {
      const body = (await request.json()) as {
        updates: Record<string, unknown>;
        resets: string[];
        replaceUnreadable: string[];
        expectedUpdatedAt: Record<string, string | null>;
      };
      saves += 1;
      if (state === "savefail")
        return Response.json({ message: "Save failed", errors: { "app.name": "The name could not be saved." } }, { status: 500 });
      if (state === "conflict" && body.expectedUpdatedAt["app.name"] !== "2026-10-28T09:41:00.000Z")
        return Response.json(
          {
            code: "conflict",
            key: "app.name",
            current: "Andere Cloud",
            changedBy: { id: "22222222-2222-4222-8222-222222222222", name: "Mara Beispiel" },
            changedAt: "2026-10-28T09:41:00.000Z",
          },
          { status: 409 },
        );
      // Someone removed the stored name: the server reports the epoch, and only "no row" is the right version.
      if (state === "conflictgone" && body.expectedUpdatedAt["app.name"] !== null)
        return Response.json(
          { code: "conflict", key: "app.name", current: "Cloud", changedBy: null, changedAt: new Date(0).toISOString() },
          { status: 409 },
        );
      if (state === "unreadable" && "app.timezone" in body.updates && !body.replaceUnreadable.includes("app.timezone"))
        return Response.json(
          { message: "Not saved", errors: { "app.timezone": "Unreadable" }, code: "setting_unreadable" },
          { status: 409 },
        );
      stored = stored.map((item) =>
        item.key in body.updates
          ? {
              ...item,
              value: item.kind === "secret" ? "" : body.updates[item.key],
              isCustom: true,
              valueSource: "custom",
              updatedAt: "2026-10-28T10:00:00.000Z",
              unreadable: false,
            }
          : body.resets.includes(item.key)
            ? { ...item, value: item.resetValue, isCustom: false, valueSource: "default", updatedAt: null }
            : item,
      );
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/admin/core/settings/legacy") return Response.json([]);
    if (url.pathname === "/api/admin/core/settings/test-freeipa") return Response.json({ ok: true });
    if (url.pathname === "/api/admin/core/settings/test-pdf") return Response.json({ bytes: 18234, contentType: "application/pdf" });
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
    saves: () => saves,
    reset() {
      stored = fixtureEntries("normal");
      saves = 0;
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const fixture = await baseAreaBrowserFixture({ port: Number(Bun.argv[2] ?? 0) });
  console.log(fixture.url);
}
