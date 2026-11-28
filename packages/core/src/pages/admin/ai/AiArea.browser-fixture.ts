/** Synthetic admin authority and AI data; the real AdminLayout, the v2 section screens and styles. No live services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CloudRuntime, User } from "@k2b/cloud/contracts";
import type { NavProps } from "@k2b/ui/v2";
import tailwind from "bun-plugin-tailwind";
import { type Context, Hono } from "hono";
import { type Component, createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../../../ui/test/ssr-test-plugin";
import { adminShellAsset, adminShellRuntime } from "../admin-v2.shell-fixture";
import type { AiFixtureApi, AiFixtureInput, AiFixtureRequest } from "./fixture-types";

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "demo-admin",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Mia",
  sn: "Muster",
  displayName: "Mia Muster",
  mail: "mia.muster@example.org",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

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

/**
 * The AI area's v2 screens as the server renders them, each with its section fixture: `/admin/ai?sec=…&state=…`
 * renders the section the address names inside the real AdminLayout and hands its props to the harness, which mounts
 * the same screen in the browser. `requests` records every API call the page sends.
 */
export async function aiAreaBrowserFixture(options: { port?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "core-ai-area-v2-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  registerSsrTestPlugin({ dev: true, rootDir: root });
  const { AdminLayout } = await import("@k2b/cloud/ssr");
  const { adminNavFixture } = await import("../admin-v2.fixture");
  const { parseAiAreaQuery, AI_AREA_SECTIONS, aiAreaHref } = await import("./area");
  const { AI_SECTION_ICON, aiSectionLabel } = await import("./frame");
  const catalog = await import("./fixture-catalog");
  const settings = await import("./fixture-settings");
  const content = await import("./fixture-content");
  const insight = await import("./fixture-insight");
  const screens = {
    classes: (await import("./ClassesScreen")).default,
    providers: (await import("./ProvidersScreen")).default,
    budgets: (await import("./BudgetsScreen")).default,
    people: (await import("./PeopleScreen")).default,
    settings: (await import("./SettingsScreen")).default,
    skills: (await import("./SkillsScreen")).default,
    projects: (await import("./ProjectsScreen")).default,
    usage: (await import("./UsageScreen")).default,
    state: (await import("./AiStateScreen")).default,
  };
  const catalogApi = catalog.createCatalogApi();
  const apis: AiFixtureApi[] = [catalogApi.api, settings.settingsApi, content.contentApi, insight.insightApi];

  const ui = resolve(import.meta.dir, "../../../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AiArea.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-ai-area-fixture",
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
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the AI area screens");
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

  const requests: AiFixtureRequest[] = [];
  const pages = new Hono<{ Variables: Variables }>();
  const localeOf = (c: Context<{ Variables: Variables }>) => (new URL(c.req.url).searchParams.get("locale") === "en" ? "en" : "de");

  /** The admin bar with the AI sections under its entry, as `aiNav` builds it, the open one current. */
  const nav = (locale: string, current: string): NavProps =>
    adminNavFixture(
      "/admin/ai",
      AI_AREA_SECTIONS.map((section) => ({
        label: aiSectionLabel(locale, section),
        icon: AI_SECTION_ICON[section],
        href: aiAreaHref({ sec: section }),
        nested: true,
        ...(section === current ? { current: true } : {}),
      })),
    );

  pages.get("/admin/ai", (c) => {
    const locale = localeOf(c);
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const state = c.req.query("state") ?? "normal";
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.set("runtime", adminShellRuntime());
    c.set("user", user);
    c.set("settings", { app: { name: "Cloud", locale } });
    c.set("page", { title: "KI", theme });
    const params = new URL(c.req.url).searchParams;
    params.delete("locale");
    params.delete("state");
    params.delete("theme");
    const query = parseAiAreaQuery(Object.fromEntries(params));
    const section = query.sec ?? "classes";
    const input: AiFixtureInput = { state, params, locale };
    const bar = nav(locale, section);
    const appNames = { core: "Cloud", mail: "Mail", workflows: "Workflows", assistant: "Assistent" };
    const pick = (): { screen: string; props: object; render: () => JSX.Element } => {
      const of = <P extends object>(screen: string, component: Component<P>, props: P) => ({
        screen,
        props,
        render: () => createComponent(component, props),
      });
      if (state === "noperm" || state === "loadfail")
        return of("state", screens.state, { nav: bar, section, kind: state === "noperm" ? "noPermission" : "failed" });
      if (section === "classes") return of("classes", screens.classes, { nav: bar, data: catalog.classesFixture(input), appNames });
      if (section === "providers") return of("providers", screens.providers, { nav: bar, data: catalog.providersFixture(input) });
      if (section === "budgets" && query.rule === "people")
        return of("people", screens.people, { nav: bar, data: insight.peopleFixture(input) });
      if (section === "budgets")
        return of("budgets", screens.budgets, { nav: bar, data: catalog.budgetsFixture(input), rule: query.rule ?? null });
      if (section === "general" || section === "jobs" || section === "tools")
        return of("settings", screens.settings, { nav: bar, data: settings.settingsFixture(input) });
      if (section === "skills") return of("skills", screens.skills, { nav: bar, data: content.skillsFixture(input) });
      if (section === "projects") return of("projects", screens.projects, { nav: bar, data: content.projectsFixture(input) });
      return of("usage", screens.usage, { nav: bar, data: insight.usageFixture(input) });
    };
    const chosen = pick();
    const body = renderToString(() =>
      createComponent(AdminLayout, {
        c,
        ui: "v2",
        title: "KI",
        get children() {
          return chosen.render();
        },
      }),
    );
    return c.html(
      `<!doctype html><html lang="${locale}" class="${theme}" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui">${body}<script type="application/json" id="screen-props" data-screen="${chosen.screen}">${JSON.stringify(chosen.props).replaceAll("<", "\\u003c")}</script><script src="/fixture.js"></script></body></html>`,
    );
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      const shellAsset = adminShellAsset(url.pathname);
      if (shellAsset) return shellAsset;
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (url.pathname.startsWith("/public/")) {
        const path = resolve(root, `.${url.pathname}`);
        return path.startsWith(`${publicDir}/`) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
      }
      if (url.pathname.startsWith("/api/")) {
        const state = new URL(request.headers.get("referer") ?? "http://x/").searchParams.get("state") ?? "normal";
        requests.push({
          method: request.method,
          path: url.pathname,
          body:
            request.method === "GET"
              ? undefined
              : await request
                  .clone()
                  .json()
                  .catch(() => undefined),
        });
        for (const api of apis) {
          const answer = await api(request, url, state);
          if (answer) return answer;
        }
        return Response.json({ message: "Synthetic fixture: service unavailable" }, { status: 503 });
      }
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/admin/ai`,
    requests,
    reset() {
      catalogApi.reset();
      requests.length = 0;
    },
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

if (import.meta.main) {
  const fixture = await aiAreaBrowserFixture({ port: Number(Bun.argv[2] ?? 0) });
  console.log(fixture.url);
}
