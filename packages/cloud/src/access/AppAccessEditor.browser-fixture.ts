/** Fictional identity and same-origin transport; actual Cloud shell, editor, denial page and built UI. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import type { AppMeta, CloudRuntime, RuntimeAppMeta } from "../contracts/app";
import type { AccessEntry, User } from "../contracts/shared";
import type { AuthContext, RequestAuthority } from "../server/middleware/auth";
import type { AppAccessChange, AppAccessSnapshot } from "../services/app-access-management";
import { preloadDisplayApps } from "../ssr/runtime";
import type { AppAccessEditorProps } from "./AppAccessEditor";

export const fixtureApp = {
  id: "invoices",
  name: "Rechnungen",
  icon: "ti ti-receipt",
  appearance: { accent: "#b45309" },
  access: { kind: "grants" },
} satisfies Pick<AppMeta, "id" | "name" | "icon" | "appearance" | "access">;
/** The approved mockup's list: two managers, a group with its member count and a standalone service account. */
export const fixtureSnapshot = (mode = "normal"): AppAccessSnapshot => {
  const snapshot: AppAccessSnapshot = {
    appId: fixtureApp.id,
    name: fixtureApp.name,
    configured: true,
    hasEffectiveManager: true,
    inheritedSignedIn: false,
    canUse: true,
    ownEntryIds: ["00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    entries: [
      {
        id: "00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        principal: { type: "user", userId: "11111111-1111-4111-8111-111111111111" },
        displayName: "Anna Muster",
        permission: "admin",
        effectiveManager: true,
        createdAt: "2026-10-22T12:00:00.000Z",
      },
      {
        id: "00000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        principal: { type: "user", userId: "22222222-2222-4222-8222-222222222222" },
        displayName: "Eva Beispiel",
        permission: "admin",
        effectiveManager: true,
        createdAt: "2026-10-22T12:00:00.000Z",
      },
      {
        id: "00000003-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        principal: { type: "group", groupId: "33333333-3333-4333-8333-333333333333" },
        displayName: "Buchhaltung",
        permission: "read",
        groupMemberCount: 4,
        effectiveManager: false,
        createdAt: "2026-10-22T12:00:00.000Z",
      },
      {
        id: "00000004-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        principal: { type: "service_account", serviceAccountId: "44444444-4444-4444-8444-444444444444" },
        displayName: "Monatsabschluss",
        serviceAccountKind: "standalone",
        permission: "read",
        effectiveManager: false,
        createdAt: "2026-10-22T12:00:00.000Z",
      },
    ],
  };
  // The service lists the transition's signed-in entry first and counts it as everyone's own.
  const inherited = {
    id: "inherited-authenticated",
    principal: { type: "authenticated" },
    permission: "read",
    createdAt: "1970-01-01T00:00:00.000Z",
  } as const;
  if (mode === "denied-revoked") {
    snapshot.entries = snapshot.entries.filter((entry) => !snapshot.ownEntryIds.includes(entry.id));
    snapshot.ownEntryIds = [];
    snapshot.canUse = false;
  }
  // The approved repair scene: an app in transition whose only entry is everyone signed in, so no one manages it.
  if (mode === "no-manager") {
    snapshot.entries = [{ ...inherited }];
    snapshot.ownEntryIds = [inherited.id];
    snapshot.hasEffectiveManager = false;
    snapshot.inheritedSignedIn = true;
    snapshot.configured = false;
  }
  if (mode === "sole-manager" || mode === "sole-effective-manager")
    snapshot.entries = snapshot.entries.filter((entry) => entry.id !== "00000002-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  if (mode === "sole-effective-manager") {
    for (const entry of snapshot.entries) {
      if (entry.principal.type === "group" || entry.principal.type === "service_account") {
        entry.permission = "admin";
        entry.effectiveManager = false;
        if (entry.principal.type === "group") entry.groupMemberCount = 0;
      }
    }
  }
  if (mode === "inherited") {
    snapshot.inheritedSignedIn = true;
    snapshot.configured = false;
    snapshot.entries.unshift({ ...inherited });
    snapshot.ownEntryIds.push(inherited.id);
  }
  if (mode === "self-group") {
    snapshot.entries[0] = {
      ...snapshot.entries[0]!,
      principal: { type: "group", groupId: "66666666-6666-4666-8666-666666666666" },
      displayName: "Finanzteam",
      groupMemberCount: 3,
    };
  }
  return snapshot;
};
export const fixtureEntity = {
  kind: "user",
  user: {
    id: "55555555-5555-4555-8555-555555555555",
    uid: "00000005-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    displayName: "Lea Fiktiv",
    mail: "lea@example.test",
    avatarHash: null,
  },
};

const user: User = {
  id: "11111111-1111-4111-8111-111111111111",
  uid: "00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  displayName: "Anna Muster",
  givenname: "Anna",
  sn: "Muster",
  mail: "anna@example.test",
  roles: ["admin", "user", "local", "local/user"],
  provider: "local",
  profile: "user",
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
};

// Discovery uses real fixed-rule resolution, so it needs neither a database nor a mocked authorization result.
// The editor below still uses fictional grant transport; it is not an enforcement fixture.
const discoveryApps: RuntimeAppMeta[] = [
  {
    id: "home",
    name: "Start",
    icon: "ti ti-home",
    description: "Fictional home",
    routes: ["/fixture"],
    access: { kind: "signedIn" },
    nav: { href: "/fixture", section: "primary" },
  },
  {
    id: "invoices",
    name: "Rechnungen",
    icon: "ti ti-receipt",
    description: "Fictional invoices",
    routes: ["/fictional/invoices"],
    access: { kind: "roles", roles: ["user"] },
    nav: { href: "/fictional/invoices", section: "primary" },
    searchLinks: [{ label: "Offene Belege", href: "/fictional/invoices/open", keywords: ["Buchhaltung"] }],
    presentation: {
      baseLocale: "de",
      translations: { en: { name: "Invoices", searchLinks: { "/fictional/invoices/open": "Open receipts" } } },
    },
  },
  {
    id: "hidden",
    name: "Geheimarchiv",
    icon: "ti ti-lock",
    description: "Fictional hidden app",
    routes: ["/fictional/hidden"],
    access: { kind: "roles", roles: ["guest"] },
    nav: { href: "/fictional/hidden", section: "primary" },
    searchLinks: [{ label: "Verborgene Belege", href: "/fictional/hidden/receipts", keywords: ["Buchhaltung"] }],
  },
];

export async function appAccessBrowserFixture() {
  const root = mkdtempSync(join(tmpdir(), "cloud-app-access-browser-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
  const [{ default: AppAccessEditor }, { AppAccessDeniedContent, AppAccessDeniedFrame }, { default: Layout }, { default: AdminLayout }] =
    await Promise.all([
      import("./AppAccessEditor"),
      import("../ssr/AppAccessDenied"),
      import("../ssr/Layout"),
      import("../ssr/AdminLayout"),
    ]);
  const { default: AppAccessBrowserFrame, AppAccessRepairFrame } = await import("./AppAccessEditor.browser-frame");
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "AppAccessEditor.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-app-access-fixture",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not compile ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "App-access browser harness build failed");
  const script = await bundle.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "App-access stylesheet build failed");
  const css = await styles.outputs[0]!.text();
  // Serve the standalone UI presets directly, as the MinimalLayout browser fixture does.
  const uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  const iconFont = /tabler-icons-[\w-]+\.woff2/.exec(icons)?.[0];
  if (!iconFont) throw new Error("Tabler preset is missing its font asset");
  const stylesheets: Record<string, string> = {
    "/public/fonts.css": (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/public/fonts/"),
    "/public/tabler-icons.css": icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/public/tabler-icons.woff2"),
  };
  const pages = new Hono<{
    Variables: {
      runtime: CloudRuntime;
      user: User;
      settings: Record<string, unknown>;
      actor: RequestAuthority["actor"];
      accessSubject: RequestAuthority["accessSubject"];
      credentialKind: AuthContext["Variables"]["credentialKind"];
      credentialScopes: string[];
      panelConsent: undefined;
      railPreferences: undefined;
      announcements: undefined;
      page: { title: string; theme: "light" | "dark" };
    };
  }>();
  const sessions = new Map<string, AppAccessSnapshot>();
  let sessionId = 0;
  // Repair renders where Core mounts it, so the administration navigation marks Apps as the current page.
  pages.use("/fixture", async (c, next) => {
    const mode = c.req.query("state");
    if (mode !== "repair" && mode !== "no-manager") return next();
    const url = new URL(c.req.url);
    url.pathname = "/admin/apps";
    url.searchParams.set("app", fixtureApp.id);
    return c.redirect(`${url.pathname}${url.search}`, 302);
  });
  pages.on("GET", ["/fixture", "/admin/apps"], async (c) => {
    const mode = c.req.query("state") ?? "normal";
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const locale = c.req.query("locale") === "en" ? "en" : "de";
    c.req.raw.headers.set("x-cloud-locale", locale);
    // Keep the request's theme and the embedded shell preference coherent.
    c.req.raw.headers.set("cookie", `${c.req.raw.headers.get("cookie") ?? ""}; theme=${theme}`);
    const discovery = mode.startsWith("discovery-");
    const identity: User = { ...user, roles: mode === "discovery-denied" ? ["admin"] : user.roles };
    const authority: RequestAuthority = {
      actor: { kind: "user", user: identity },
      accessSubject: { type: "user", userId: identity.id },
      credentialKind: "session",
      scopes: [],
    };
    c.set("actor", authority.actor);
    c.set("accessSubject", authority.accessSubject);
    c.set("credentialKind", authority.credentialKind);
    c.set("credentialScopes", authority.scopes);
    c.set("runtime", {
      apps: discovery
        ? discoveryApps
        : [
            {
              ...fixtureApp,
              // Shell visibility is synthetic here; grant enforcement is tested against real storage separately.
              access: mode.startsWith("denied") || mode === "no-manager" ? { kind: "roles", roles: ["guest"] } : { kind: "signedIn" },
              description: "Fictional browser fixture",
              routes: ["/fixture"],
              nav: { href: "/fixture", section: "primary" },
            },
          ],
    });
    c.set("user", identity);
    await preloadDisplayApps(c);
    c.set("settings", { app: { name: "Cloud", locale } });
    c.set("page", { title: discovery ? "Cloud" : "Rechnungen · Zugriff", theme });
    const initial = fixtureSnapshot(mode);
    const repair = mode === "repair" || mode === "no-manager";
    const props: AppAccessEditorProps = {
      app:
        mode === "fixed"
          ? { ...fixtureApp, access: { kind: "roles", roles: ["admin"] } }
          : mode === "inherited" || mode === "no-manager"
            ? { ...fixtureApp, access: { kind: "grants", until: { kind: "signedIn" } } }
            : fixtureApp,
      repair,
      ...(mode === "load" ? {} : { initial }),
    };
    const id = String(++sessionId);
    sessions.set(id, initial);
    const body = renderToString(() =>
      createComponent(repair ? AdminLayout : Layout, {
        c,
        title: discovery ? "Cloud" : mode.startsWith("denied") ? fixtureApp.name : "Rechnungen · Zugriff",
        fullWidth: true,
        fullPage: true,
        ...(repair ? { contentClass: "px-4 pt-2 pb-24 sm:px-8 sm:pt-5 sm:pb-12" } : {}),
        get children() {
          if (discovery) return createComponent(Dynamic, { component: "div", id: "app-access-discovery-fixture" });
          if (mode.startsWith("denied"))
            return createComponent(AppAccessDeniedFrame, {
              get children() {
                return createComponent(AppAccessDeniedContent, {
                  app: mode === "denied-fixed" ? { ...fixtureApp, access: { kind: "roles", roles: ["admin"] } } : fixtureApp,
                  // The service names only effective managers on this page.
                  managers: mode === "denied-fixed" ? [] : initial.entries.filter((entry) => entry.effectiveManager),
                  canRepair: mode === "denied-admin",
                  revoked: mode === "denied-revoked",
                });
              },
            });
          const editor = () =>
            createComponent(Dynamic, {
              component: "div",
              id: "app-access-fixture",
              get children() {
                return createComponent(AppAccessEditor, props);
              },
            });
          return repair
            ? createComponent(AppAccessRepairFrame, {
                name: fixtureApp.name,
                get children() {
                  return editor();
                },
              })
            : createComponent(AppAccessBrowserFrame, {
                get children() {
                  return editor();
                },
              });
        },
      }),
    );
    c.header("Set-Cookie", `app-access-fixture=${id}; Path=/; SameSite=Lax`);
    return c.html(
      `<!doctype html><html lang="${locale}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui">${body}${mode.startsWith("denied") ? "" : `<script type="application/json" id="app-access-fixture-data">${JSON.stringify(discovery ? {} : props)}</script><script src="/fixture.js"></script>`}</body></html>`,
    );
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/branding/logo")
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#18181b"/><text x="16" y="22" text-anchor="middle" font-family="sans-serif" font-size="19" fill="white">C</text></svg>',
          { headers: { "Content-Type": "image/svg+xml" } },
        );
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (stylesheets[url.pathname]) return new Response(stylesheets[url.pathname], { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/public/tabler-icons.woff2") return new Response(Bun.file(resolve(uiDist, iconFont)));
      if (url.pathname.startsWith("/public/fonts/")) {
        const fontsDir = resolve(uiDist, "fonts");
        const path = resolve(fontsDir, url.pathname.slice("/public/fonts/".length));
        return path.startsWith(`${fontsDir}/`) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
      }
      if (url.pathname === "/api/accounts/entities" && request.method === "GET")
        return Response.json({
          items: fixtureEntity.user.displayName.toLowerCase().includes((url.searchParams.get("search") ?? "").toLowerCase())
            ? [fixtureEntity]
            : [],
        });
      if (url.pathname === "/_cloud/app-access/invoices") {
        const id = request.headers.get("cookie")?.match(/(?:^|;\s*)app-access-fixture=(\d+)/)?.[1];
        const state = id ? sessions.get(id) : undefined;
        if (!state) return Response.json({ code: "FIXTURE_SESSION_MISSING" }, { status: 400 });
        if (request.method === "GET") return Response.json(state);
        if (request.method === "POST") {
          const change: AppAccessChange = await request.json();
          let entry: AccessEntry | undefined;
          if (change.action === "grant") {
            entry = {
              id: `99999999-aaaa-4aaa-8aaa-${String(state.entries.length).padStart(12, "0")}`,
              principal: change.principal,
              permission: change.permission,
              displayName: fixtureEntity.user.displayName,
              createdAt: "2026-10-22T12:00:00.000Z",
            };
            state.entries.push(entry);
          } else if (change.action === "update") {
            entry = state.entries.find((candidate) => candidate.id === change.accessId);
            if (entry) entry.permission = change.permission;
          } else state.entries = state.entries.filter((entry) => entry.id !== change.accessId);
          state.hasEffectiveManager = state.entries.some((entry) => entry.permission === "admin");
          return Response.json({ entry, canUse: true });
        }
      }
      // Unexpected API requests fail closed and can never reach the live stack.
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_cloud/"))
        return Response.json({ code: "UNEXPECTED_FIXTURE_REQUEST" }, { status: 503 });
      return pages.fetch(request);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/fixture`,
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
