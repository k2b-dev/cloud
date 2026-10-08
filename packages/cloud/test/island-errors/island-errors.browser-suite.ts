import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { browserName, launchBrowser } from "../../../ui/test/browser";

// This directory is a small Cloud app: `src/` holds its islands. The server render
// must give each island the ID that the app's own build gives it, so both use it
// as their root. This plugin only renders; the app build below emits the bundles
// into a directory of this process, so runs side by side in one checkout, such as
// Chromium and WebKit, never build over or delete each other's bundles.
const appRoot = import.meta.dir;
const outdir = mkdtempSync(join(tmpdir(), "cloud-island-errors-"));
const { plugin } = createConfig({ rootDir: appRoot, componentRoots: [] });
Bun.plugin(plugin());

const { defineApp } = await import("../../src/_internal/define-app");
const { default: ProbePage } = await import("./src/ProbePage");

const app = defineApp({
  id: "island-probe",
  name: "Island Probe",
  icon: "ti ti-bug",
  description: "Island error probe",
  baseUrl: "http://island-probe:3000",
  routes: ["/app/island-probe"],
  appRoot,
});

const ui = resolve(appRoot, "../../../ui/dist");
/** The flaky feed answers with an item without a label, which its row cannot render. */
let flakyBroken = false;
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;

beforeAll(async () => {
  // The app's plugin builds every island of the app and of Cloud, as `bun run build` does.
  const islands = await Bun.build({ entrypoints: [join(appRoot, "src/probe-store.ts")], plugins: [app.plugin()], outdir });
  if (!islands.success) throw new AggregateError(islands.logs, "Could not build the islands.");
  const css = await Bun.build({ entrypoints: [resolve(appRoot, "../../src/styles/global.css")], plugins: [tailwind] });
  if (!css.success) throw new AggregateError(css.logs, "Could not compile the global stylesheet.");
  const globalCss = await css.outputs[0]!.text();

  const routesApp = new Hono()
    // The page asks for `/_ssr/<build version>/<id>.js`; its chunks sit next to it.
    .get("/_ssr/*", (c) => new Response(Bun.file(join(outdir, "_ssr", basename(c.req.path)))))
    .get("/public/global.css", (c) => c.body(globalCss, 200, { "content-type": "text/css" }))
    .get("/public/tabler-icons.css", () => new Response(Bun.file(join(ui, "tabler.css"))))
    .get("/public/:file{tabler-icons-.+\\.woff2}", (c) => new Response(Bun.file(join(ui, c.req.param("file")))))
    .get("/probe/:feed", (c) => {
      const revision = Number(c.req.query("revision"));
      const broken = c.req.param("feed") === "flaky" && flakyBroken;
      return c.json(broken ? [{ id: "a" }] : [{ id: "a", label: `revision ${revision}` }]);
    })
    .get("/", ...app.ssr(() => () => createComponent(ProbePage, {})));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: routesApp.fetch });
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  rmSync(outdir, { recursive: true, force: true });
});

const open = async (locale: "en-US" | "de-DE") => {
  flakyBroken = false;
  const context = await browser.newContext({ locale, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const reported: string[] = [];
  page.on("pageerror", (error) => reported.push(error.message));
  await page.goto(server.url.href);
  // Each island marks its browser render; the server markup has no marker.
  await page.waitForFunction(() => document.querySelectorAll("[data-mounted]").length === 3);
  return { page, reported };
};

const feed = (page: Page, name: string) => page.locator(`section[data-feed="${name}"]`);
const showsRevision = (page: Page, name: string, revision: number) =>
  feed(page, name).getByText(`REVISION ${revision}`, { exact: true }).waitFor();
const next = async (page: Page, revision: number) => {
  await page.getByRole("button", { name: "Next revision" }).click();
  await page.getByTestId("revision").getByText(String(revision), { exact: true }).waitFor();
};

describe(`island error fallback in ${browserName}`, () => {
  test("replaces only the failing island, keeps the others updating, and recovers on retry", async () => {
    const { page, reported } = await open("en-US");
    try {
      await next(page, 2);
      await showsRevision(page, "flaky", 2);

      // The query update commits an item that a row nested in the list cannot render.
      flakyBroken = true;
      await next(page, 3);
      const alert = page.getByRole("alert");
      await alert.getByText("This section could not be displayed.", { exact: true }).waitFor();
      expect(await feed(page, "flaky").count()).toBe(0);
      await showsRevision(page, "steady", 3);
      // The boundary reports the error once, through reportError.
      expect(reported).toHaveLength(1);
      expect(reported[0]).toContain("toUpperCase");

      // The same signal still reaches the other islands: nothing is frozen.
      await next(page, 4);
      await showsRevision(page, "steady", 4);

      // Once the data is fine again, "Try again" remounts the island, which loads the current revision.
      flakyBroken = false;
      await alert.getByRole("button", { name: "Try again" }).click();
      await showsRevision(page, "flaky", 4);
      expect(await page.getByRole("alert").count()).toBe(0);
      expect(reported).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  }, 60_000);

  test("speaks the request language", async () => {
    const { page } = await open("de-DE");
    try {
      expect(await page.locator("html").getAttribute("lang")).toBe("de-DE");
      flakyBroken = true;
      await next(page, 2);
      const alert = page.getByRole("alert");
      await alert.getByText("Dieser Bereich konnte nicht angezeigt werden.", { exact: true }).waitFor();
      expect(await alert.getByRole("button", { name: "Erneut versuchen" }).isVisible()).toBe(true);
    } finally {
      await page.context().close();
    }
  }, 60_000);
});
