import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as server from "@k2b/cloud/server";
import { appAppearanceStyle } from "@k2b/cloud/ssr/app-appearance";
import { LocaleProvider } from "@k2b/ui";
import { Hono } from "hono";
import { createComponent, type JSX } from "solid-js";
import { layoutProblems } from "../../../ui/src/layout-check";
import { launchBrowser } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { Venue } from "../contracts";

// Whether the Venue overview fits its column at every width, without overlaps, cut text or a sideways scroll, is
// decided by the cascade of Tailwind, Cloud and @k2b/ui styles, which only a real engine resolves.
const root = mkdtempSync(join(tmpdir(), "venue-page-browser-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

const cloudSsr = await import("@k2b/cloud/ssr");
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { venueService } = await import("../service");
const { default: page } = await import("./page");
const publicDir = join(root, "public");
// Venue has no Tailwind or Playwright dependency of its own; the stylesheet compiles with Core's plugin, as Core's
// page tests do.
const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", resolve(import.meta.dir, "../../../core")))).default;
const origin = "https://cloud.example.test";

// The page tests of every app use these widths: a phone, a tablet, a laptop with an open detail column, a desktop.
const layoutWidths = [390, 768, 1100, 1440] as const;
// Classic, visible scrollbars, as on most desktops: only then does a scrollbar take its width, so a column a few
// pixels too wide shows up as a sideways scroller.
const classicScrollbars = { ignoreDefaultArgs: ["--hide-scrollbars"] };

// Venue's canvas paint (src/config.ts). The page renders in a stand-in for the page shell without the rail and
// header, which have tests of their own.
const VENUE_CANVAS = appAppearanceStyle({ accent: "#a16207", background: { from: "#d97706", to: "#f59e0b", angle: 135 } });

const now = "2026-09-30T10:00:00.000Z";
/** Invented venues: a long name, every permission, with and without a public page. */
const venue = (fields: Pick<Venue, "id" | "slug" | "name" | "icon"> & Partial<Venue>): Venue => ({
  description: null,
  timezone: "Europe/Berlin",
  openMode: "regular",
  signupMode: "both",
  publicEnabled: true,
  feedbackEnabled: false,
  accentColor: "#2563eb",
  logoBase64: null,
  bannerBase64: null,
  permission: "admin",
  createdAt: now,
  updatedAt: now,
  ...fields,
});
const venues: Venue[] = [
  venue({ id: "Cafe01", slug: "campus-cafe", name: "Campus-Café", icon: "ti ti-coffee", description: "Opening hours and shifts" }),
  venue({
    id: "Desk01",
    slug: "service-desk",
    name: "Service desk of the student union in the main building, ground floor",
    icon: "ti ti-help-circle",
    description: "Front desk with a long description that runs over more than one line on a phone and a tablet",
    permission: "read",
    publicEnabled: false,
  }),
  venue({ id: "Hall01", slug: "event-hall", name: "Event hall", icon: "ti ti-building", signupMode: "templates", permission: "write" }),
];

/** The venues the signed-in person sees; each test sets them. */
let visible: Venue[] = venues;
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  visible = venues;
  spies.push(
    spyOn(cloudSsr, "Layout").mockImplementation(((props: { c: Parameters<typeof server.getLocale>[0]; children: JSX.Element }) =>
      createComponent(LocaleProvider, {
        locale: server.getLocale(props.c),
        get children() {
          return props.children;
        },
      })) as never),
    spyOn(venueService.venues, "list").mockImplementation(async () => visible as never),
    spyOn(venueService.publicResources, "projectVenues").mockImplementation(async (items) => items),
  );
});
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

let browser: Awaited<ReturnType<typeof launchBrowser>>;
let css: string;
beforeAll(async () => {
  // As the page template does: the layer order first, then Venue's stylesheet, then the global one.
  const styles = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const built = await Promise.all(styles.map((entry) => Bun.build({ entrypoints: [entry], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  // Text and icon widths decide where rows wrap, so the page gets its real fonts.
  await (await import("../../../core/scripts/font-assets")).buildFontAssets(publicDir);
  await (await import("../../../core/scripts/tabler-assets")).buildTablerIconAssets(publicDir);
  browser = await launchBrowser(classicScrollbars);
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** The server-rendered content of the Venue overview. */
const content = async (locale: "en" | "de") => {
  const app = new Hono()
    .use("*", async (c, next) => {
      c.set("actor" as never, { kind: "user", user: { id: "00000000-0000-4000-8000-000000000042", uid: "jbeispiel" } } as never);
      await next();
    })
    .get("/app/venue", ...page);
  const response = await app.request(`${origin}/app/venue`, { headers: { Cookie: `cloud.locale=${locale}` } });
  expect(response.status).toBe(200);
  return /<body[^>]*>([\s\S]*)<\/body>/.exec(await response.text())![1]!;
};

/** Layout problems of the server-rendered overview on Venue's canvas, before any island renders again. */
const problemsAt = async (width: number, locale: "en" | "de") => {
  const tab = await browser.newPage({ javaScriptEnabled: false, viewport: { width, height: 900 }, deviceScaleFactor: 1 });
  try {
    await tab.route(`${origin}/public/**`, (route) => route.fulfill({ path: join(root, new URL(route.request().url()).pathname) }));
    await tab.setContent(
      `<!doctype html><html lang="${locale}" class="light"><head><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<link rel="stylesheet" href="${origin}/public/fonts.css"><link rel="stylesheet" href="${origin}/public/tabler-icons.css"><style>${css}</style></head>` +
        `<body class="k2b-ui"><div class="cloud-app-canvas relative flex min-h-dvh w-full" style="${VENUE_CANVAS}" data-app-id="venue">` +
        `<div class="layout-shell-content flex min-h-0 min-w-0 flex-1 flex-col"><main class="layout-content-main min-h-0 min-w-0 flex-1">` +
        `${await content(locale)}</main></div></div></body></html>`,
    );
    await tab.evaluate(() => document.fonts.ready);
    await tab.locator("main").waitFor();
    return (await tab.evaluate(layoutProblems, { root: "main" })).problems;
  } finally {
    await tab.close();
  }
};

describe("Venue overview page in a browser", () => {
  test("lays out its venues without overlap, cut text or sideways scroll at every width", async () => {
    const found: Record<string, string[]> = {};
    for (const locale of ["en", "de"] as const) {
      for (const width of layoutWidths) {
        const problems = await problemsAt(width, locale);
        if (problems.length > 0) found[`${locale} ${width}`] = problems;
      }
    }
    expect(found).toEqual({});
  }, 120_000);

  test("lays out its first empty state at every width", async () => {
    visible = [];
    const found: Record<string, string[]> = {};
    for (const width of layoutWidths) {
      const problems = await problemsAt(width, "en");
      if (problems.length > 0) found[width] = problems;
    }
    expect(found).toEqual({});
  }, 60_000);
});
