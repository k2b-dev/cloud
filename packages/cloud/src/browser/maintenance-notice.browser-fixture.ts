/** A fictional Mail reply inside the real Cloud Layout and ShellRuntime island; the gateway's answers are scripted. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import { createComponent } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { CloudRuntime } from "../contracts/app";
import {
  formatUnavailableHeader,
  GATEWAY_STATUS_PATH,
  type GatewayStatus,
  MAINTENANCE_ADMIN_API_PATH,
  MAINTENANCE_BYPASS_HEADER,
  UNAVAILABLE_HEADER,
  type UnavailableSignal,
} from "../contracts/maintenance-signals";
import type { User } from "../contracts/shared";

/**
 * The approved mockup's states, in its order, plus the bypass notice:
 * - `vorher`: everything answers;
 * - `app-updating`: Mail deregistered for an update; its reads and sends get the gateway's `503`;
 * - `maintenance`: the whole Cloud is in maintenance;
 * - `done`: the page met the update once, and the next status check says Mail is back;
 * - `bypass-admin`: an administrator passed the maintenance wall with a bypass link.
 */
export const MAINTENANCE_NOTICE_SCENARIOS = ["vorher", "app-updating", "maintenance", "done", "bypass-admin"] as const;
export type MaintenanceNoticeScenario = (typeof MAINTENANCE_NOTICE_SCENARIOS)[number];

/** The reply Lea Muster is writing when the update begins. */
export const MAINTENANCE_NOTICE_REPLY = "Hallo Jonas, ja, das passt. Der Schlüssel liegt ab 16:30 Uhr im Vereinsheim bereit.";
export const MAINTENANCE_NOTICE_THREAD_PATH = "/app/mail/api/threads/hallenbelegung";
export const MAINTENANCE_NOTICE_SEND_PATH = "/app/mail/api/threads/hallenbelegung/reply";
const PAGE_PATH = "/app/mail/vorstand";

const user = (admin: boolean): User => ({
  id: "11111111-1111-4111-8111-111111111111",
  uid: "lea.muster",
  roles: admin ? ["admin", "user", "local", "local/user"] : ["user", "local", "local/user"],
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
});

const runtime: CloudRuntime = {
  apps: [
    {
      id: "mail",
      name: "Mail",
      icon: "ti ti-mail",
      description: "Fictional mail",
      routes: ["/app/mail"],
      nav: { href: PAGE_PATH, section: "primary" },
    },
  ],
};

/** The gateway's `503` problems, as `packages/gateway/src/unavailable-answer.ts` writes them. */
const problem = (body: Record<string, unknown>, signal: UnavailableSignal, retryAfter: number): Response =>
  new Response(JSON.stringify({ type: "about:blank", status: 503, ...body }), {
    status: 503,
    headers: {
      "Content-Type": "application/problem+json",
      "Retry-After": String(retryAfter),
      [UNAVAILABLE_HEADER]: formatUnavailableHeader(signal),
    },
  });
const maintenanceProblem = () => problem({ title: "Cloud is in maintenance", code: "maintenance" }, { code: "maintenance" }, 30);
const updatingProblem = () =>
  problem(
    { title: "App is unavailable", code: "app_unavailable", appId: "mail", appName: "Mail", reason: "updating" },
    { code: "app_unavailable", appId: "mail", reason: "updating" },
    5,
  );

export async function maintenanceNoticeBrowserFixture() {
  const root = mkdtempSync(join(tmpdir(), "cloud-maintenance-notice-browser-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  registerSsrTestPlugin({ dev: true, rootDir: root });
  const [{ default: Layout }, { preloadDisplayApps }] = await Promise.all([import("../ssr/Layout"), import("../ssr/runtime")]);
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  const bundle = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "maintenance-notice.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-maintenance-notice-fixture",
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
  if (!bundle.success) throw new AggregateError(bundle.logs, "Maintenance notice browser harness build failed");
  const script = await bundle.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Maintenance notice stylesheet build failed");
  const css = await styles.outputs[0]!.text();
  // The standalone UI presets, served as the app-access fixture does.
  const uiDist = dirname(fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css")));
  const icons = await Bun.file(resolve(uiDist, "tabler.css")).text();
  const iconFont = /tabler-icons-[\w-]+\.woff2/.exec(icons)?.[0];
  if (!iconFont) throw new Error("Tabler preset is missing its font asset");
  const stylesheets: Record<string, string> = {
    "/public/fonts.css": (await Bun.file(resolve(uiDist, "plex.css")).text()).replaceAll("./fonts/", "/public/fonts/"),
    "/public/tabler-icons.css": icons.replace(/\.\/tabler-icons-[\w-]+\.woff2(\?[^)]*)?/, "/public/tabler-icons.woff2"),
  };

  // One scripted gateway, reset when a page names its scenario.
  const state = { scenario: "vorher" as MaintenanceNoticeScenario, met: false, ended: false };
  const control = { requests: [] as string[] };

  /** What the gateway answers to an app request in the current scenario; null passes it to the app. */
  const gateway = (): Response | null => {
    if (state.scenario === "maintenance") return maintenanceProblem();
    if (state.scenario === "app-updating") return updatingProblem();
    if (state.scenario === "done" && !state.met) {
      state.met = true;
      return updatingProblem();
    }
    return null;
  };
  const status = (app: boolean): GatewayStatus => {
    const maintenance =
      state.scenario === "maintenance"
        ? ({ active: true, until: null } as const)
        : state.scenario === "bypass-admin" && !state.ended
          ? ({ active: true, until: null, bypass: true } as const)
          : null;
    return app ? { maintenance, app: { available: state.scenario !== "app-updating" } } : { maintenance };
  };

  const pages = new Hono<{
    Variables: {
      runtime: CloudRuntime;
      user: User;
      settings: Record<string, unknown>;
      actor: undefined;
      panelConsent: undefined;
      railPreferences: undefined;
      announcements: undefined;
      page: { title: string; theme: "light" | "dark" };
    };
  }>();
  pages.get(PAGE_PATH, async (c) => {
    const scenario = MAINTENANCE_NOTICE_SCENARIOS.find((name) => name === c.req.query("state")) ?? "vorher";
    Object.assign(state, { scenario, met: false, ended: false });
    const theme = c.req.query("theme") === "dark" ? "dark" : "light";
    const locale = c.req.query("locale") === "en" ? "en" : "de";
    c.req.raw.headers.set("x-cloud-locale", locale);
    c.req.raw.headers.set("cookie", `theme=${theme}`);
    // Only the gateway sets this header, and only for a browser with a valid bypass link.
    if (scenario === "bypass-admin") c.req.raw.headers.set(MAINTENANCE_BYPASS_HEADER, "1");
    c.set("runtime", runtime);
    c.set("user", user(scenario === "bypass-admin"));
    await preloadDisplayApps(c);
    c.set("settings", { app: { name: "Musterverein Cloud", locale } });
    c.set("page", { title: "Mail", theme });
    const body = renderToString(() =>
      createComponent(Layout, {
        c,
        title: [{ title: "Mail", href: PAGE_PATH }, { title: "Hallenbelegung im Dezember" }],
        get children() {
          return createComponent(Dynamic, { component: "div", id: "maintenance-notice-fixture", class: "w-full" });
        },
      }),
    );
    return c.html(
      `<!doctype html><html lang="${locale}" class="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css"><style>${css}</style></head><body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}">${body}<script type="application/json" id="maintenance-notice-fixture-data">${JSON.stringify({ reply: MAINTENANCE_NOTICE_REPLY, thread: MAINTENANCE_NOTICE_THREAD_PATH, send: MAINTENANCE_NOTICE_SEND_PATH })}</script><script src="/fixture.js"></script></body></html>`,
    );
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/branding/logo")
        return new Response(Bun.file(resolve(import.meta.dir, "../../public/logo.svg")), { headers: { "Content-Type": "image/svg+xml" } });
      if (url.pathname === "/fixture.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      if (stylesheets[url.pathname]) return new Response(stylesheets[url.pathname], { headers: { "Content-Type": "text/css" } });
      if (url.pathname === "/public/tabler-icons.woff2") return new Response(Bun.file(resolve(uiDist, iconFont)));
      if (url.pathname.startsWith("/public/fonts/")) {
        const fontsDir = resolve(uiDist, "fonts");
        const path = resolve(fontsDir, url.pathname.slice("/public/fonts/".length));
        return path.startsWith(`${fontsDir}/`) ? new Response(Bun.file(path)) : new Response(null, { status: 404 });
      }
      if (url.pathname === PAGE_PATH) return pages.fetch(request);
      control.requests.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === GATEWAY_STATUS_PATH) return Response.json(status(url.searchParams.has("app")));
      // Core ends the maintenance; the gateway passes this path through for the bypassing administrator.
      if (url.pathname === `${MAINTENANCE_ADMIN_API_PATH}/off` && request.method === "POST" && state.scenario === "bypass-admin") {
        state.ended = true;
        return Response.json({ active: false });
      }
      if (url.pathname === MAINTENANCE_NOTICE_THREAD_PATH && request.method === "GET")
        return gateway() ?? Response.json({ subject: "Hallenbelegung im Dezember", messages: 1 });
      if (url.pathname === MAINTENANCE_NOTICE_SEND_PATH && request.method === "POST") return gateway() ?? Response.json({ sent: true });
      // Unexpected requests fail closed and can never reach a live stack.
      return Response.json({ code: "UNEXPECTED_FIXTURE_REQUEST" }, { status: 404 });
    },
  });
  return {
    url: (scenario: MaintenanceNoticeScenario, query = "") => `http://127.0.0.1:${server.port}${PAGE_PATH}?state=${scenario}${query}`,
    control,
    close() {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
