import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

// An app's own stylesheet compiles without Cloud's theme: it emits theme-free utilities such as `flex` and
// `grid-cols-1`, but no breakpoint variant such as `md:grid-cols-2`. Those come only from the shared stylesheet. Both
// sheets put their utilities in `@layer utilities` at equal specificity, so the later sheet wins. The app page links
// the shared sheet after the app's, or the app's `grid-cols-1` cancels the shared `md:grid-cols-2` on every page.
const root = mkdtempSync(resolve(tmpdir(), "cloud-css-order-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { defineApp } = await import("./define-app");

const app = defineApp({
  id: "order-probe",
  name: "Order Probe",
  icon: "ti ti-stack",
  description: "Stylesheet order probe",
  baseUrl: "http://order-probe:3000",
  routes: ["/app/order-probe"],
});
const ssrDocument = new Hono().get("/", ...app.ssr(() => () => "order probe"));

const buildCss = async (name: string, source: string): Promise<string> => {
  const entry = resolve(root, name);
  writeFileSync(entry, source);
  const result = await Bun.build({ entrypoints: [entry], outdir: resolve(root, "out"), naming: name, plugins: [tailwind] });
  if (!result.success || !result.outputs[0]) throw new AggregateError(result.logs, `${name} build failed`);
  return await result.outputs[0].text();
};

const tailwindCss = (path: string) => JSON.stringify(Bun.resolveSync(path, import.meta.dir));
const classes = "flex md:hidden grid grid-cols-1 md:grid-cols-2";
let globalCss: string;
let appCss: string;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  // The shared stylesheet in its real shape: full Tailwind with its theme, scanning every package's markup.
  globalCss = await buildCss(
    "global.css",
    `@import ${tailwindCss("tailwindcss/index.css")} source(none);\n@source inline("${classes}");\n`,
  );
  // An app's stylesheet in the shape every app ships: utilities without a theme, scanning only its own markup.
  appCss = await buildCss(
    "app.css",
    `@import ${tailwindCss("tailwindcss/utilities.css")} layer(utilities) source(none);\n@source inline("${classes}");\n`,
  );
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/public/global.css") return new Response(globalCss, { headers: { "Content-Type": "text/css" } });
      if (pathname === "/public/order-probe/app.css") return new Response(appCss, { headers: { "Content-Type": "text/css" } });
      if (pathname === "/") return ssrDocument.request("/");
      return new Response("", { status: 404 });
    },
  });
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

test("an app's theme-free utility does not cancel a shared breakpoint variant on a desktop page", async () => {
  // Guard the premise: the app sheet repeats the plain utilities but cannot build the breakpoint variants.
  expect(appCss).toContain(".grid-cols-1");
  expect(appCss).toContain(".flex");
  expect(appCss).not.toContain("md\\:");
  expect(globalCss).toContain(".md\\:grid-cols-2");
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(server.url.origin + "/");
    await settled(page);
    const style = await page.evaluate(() => {
      const probe = (className: string) => {
        const element = Object.assign(document.createElement("div"), { className });
        document.body.append(element);
        return getComputedStyle(element);
      };
      return {
        // The phone header in `LayoutHeader`: hidden from `md` on.
        header: probe("flex md:hidden").display,
        // Weather's forecast beside the rain radar.
        columns: probe("grid grid-cols-1 md:grid-cols-2").gridTemplateColumns.split(" ").length,
      };
    });
    expect(style).toEqual({ header: "none", columns: 2 });
  } finally {
    await page.close();
  }
});
