import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { BunPlugin } from "bun";
import rawTailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import appTailwind from "../../scripts/tailwind";

// #3921: the shared stylesheet and an app's own both put their utilities in `@layer utilities` at equal
// specificity, so the later stylesheet wins. An app's own utility must beat a shared one on the same property.
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

const buildCss = async (name: string, source: string, plugin: BunPlugin): Promise<string> => {
  const entry = resolve(root, name);
  writeFileSync(entry, source);
  const result = await Bun.build({ entrypoints: [entry], outdir: resolve(root, "out"), naming: name, plugins: [plugin] });
  if (!result.success || !result.outputs[0]) throw new AggregateError(result.logs, `${name} build failed`);
  return await result.outputs[0].text();
};

const tailwindCss = (path: string) => JSON.stringify(Bun.resolveSync(path, import.meta.dir));
let globalCss: string;
let appCss: string;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  // The shared stylesheet in its real shape: full Tailwind with its theme, built by Core with the plain plugin.
  globalCss = await buildCss(
    "global.css",
    `@import ${tailwindCss("tailwindcss/index.css")} source(none);\n@source inline("m-0 transition");\n`,
    rawTailwind,
  );
  // An app's stylesheet in the starter's shape: utilities without a theme, built by Cloud's app build.
  appCss = await buildCss(
    "app.css",
    `@import ${tailwindCss("tailwindcss/utilities.css")} layer(utilities) source(none);\n@source inline("mt-[-4px] transition");\n`,
    appTailwind,
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

test("an app's own utility beats a shared one on the same property, and its transitions keep the shared defaults", async () => {
  // Guard the premise: each sheet carries its own rule for the property.
  expect(globalCss).toContain(".m-0");
  expect(appCss).toContain(".mt-\\[-4px\\]");
  const page = await browser.newPage();
  try {
    await page.goto(server.url.origin + "/");
    const style = await page.evaluate(() => {
      const probe = Object.assign(document.createElement("div"), { className: "m-0 mt-[-4px] transition" });
      document.body.append(probe);
      const computed = getComputedStyle(probe);
      return {
        marginTop: computed.marginTop,
        marginBottom: computed.marginBottom,
        duration: computed.transitionDuration,
        easing: computed.transitionTimingFunction,
      };
    });
    expect(style).toEqual({
      // The app's `mt-[-4px]` wins over the shared `m-0`; the shared rule still sets the other sides.
      marginTop: "-4px",
      marginBottom: "0px",
      // The app's `transition` points at the shared theme's defaults instead of ending at once.
      duration: "0.15s",
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
    });
  } finally {
    await page.close();
  }
});
