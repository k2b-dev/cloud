import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import { Hono } from "hono";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { launchBrowser } from "../../../ui/test/browser";
import type { CloudRuntime } from "../contracts/app";
import type { User } from "../contracts/shared";

const root = mkdtempSync(resolve(tmpdir(), "cloud-help-browser-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: Layout } = await import("./Layout");
const { defineApp } = await import("../_internal/define-app");
const { person } = await import("../_internal/define-app.test-fixture");
const rail = await import("../services/rail-snapshot");
const settings = await import("../server/middleware/settings");
const help = await import("./help");
const { defaultRailPreferences } = await import("../contracts/rail-preferences");
const apps: CloudRuntime["apps"] = [
  {
    id: "spaces",
    name: "Spaces",
    icon: "ti ti-box",
    description: "Spaces",
    routes: ["/app/spaces"],
    appearance: { accent: "#16a34a" },
    nav: { href: "/app/spaces", section: "primary" },
  },
  { id: "core", name: "Core", icon: "ti ti-cloud", description: "Core", routes: ["/help"] },
];
const probe = defineApp({
  id: "help-browser",
  name: "Help browser",
  icon: "ti ti-help",
  description: "Help fixture",
  baseUrl: "http://help-browser:3000",
  routes: ["/help"],
});
const pages = new Hono<{ Variables: { runtime: CloudRuntime; user: User } }>()
  .use(async (c, next) => {
    c.set("runtime", { apps });
    c.set("user", person);
    await next();
  })
  .get(
    "/help/apps/spaces",
    ...probe.ssr(
      (c) => () => createComponent(Layout, { c, title: [{ title: "Spaces", href: "/app/spaces" }, { title: "Help" }], children: "" }),
    ),
  );
let browser: Browser;
let markup: string;
let bundle: string;
const spies: { mockRestore(): void }[] = [];
beforeAll(async () => {
  spies.push(
    spyOn(rail, "readRailSnapshot").mockResolvedValue(defaultRailPreferences()),
    spyOn(settings, "preloadLayoutAnnouncements").mockResolvedValue(undefined),
    spyOn(help, "preloadLayoutHelp").mockResolvedValue(null),
  );
  const ui = `${resolve(import.meta.dir, "../../../ui")}/`;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "LayoutHelp.browser-harness.tsx")],
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "solid-help-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Could not bundle Help reader");
  bundle = await build.outputs[0]!.text();
  const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!styles.success) throw new AggregateError(styles.logs, "Could not compile global stylesheet");
  const css = await styles.outputs[0]!.text();
  const response = await pages.request("/help/apps/spaces");
  markup = (await response.text())
    .replace(/<script type="module">[^<]*solid-island[^<]*<\/script>/g, "")
    .replace("</head>", `<style>${css}</style></head>`);
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  for (const spy of spies) spy.mockRestore();
  await browser?.close();
});
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  await page.route("http://cloud.test/**", (route) => route.fulfill({ contentType: "text/html", body: markup }));
  await page.goto(`http://cloud.test/help/apps/spaces${query}`);
  await page.addScriptTag({ content: bundle });
  await page.locator("[data-help-search]").waitFor();
  return page;
};

test("the TOC stays in view and follows Layout's actual page scroller", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Topic 0", exact: false }).first().click();
    // The frame and its reserved TOC column exist before the body arrives.
    await page.locator(".help-article-layout").waitFor();
    expect(await page.locator("article h3").textContent()).toBe("Topic 0");
    await page.locator('.help-article-toc button[aria-current="location"]').waitFor();
    const before = await page.locator('.help-article-toc button[aria-current="location"]').getAttribute("title");
    expect(await page.locator(".cloud-app-canvas").getAttribute("style")).toContain("--app-accent:#16a34a");
    await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>(".layout-content-main")!;
      main.scrollTop = 2000;
    });
    await page.waitForFunction(
      () => document.querySelector('.help-article-toc button[aria-current="location"]')?.getAttribute("title") !== "Section 0",
    );
    expect(await page.locator('.help-article-toc button[aria-current="location"]').getAttribute("title")).not.toBe(before);
    const rect = await page.locator(".help-article-toc").boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(900);
    expect(await page.locator(".layout-content-main").evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(2000);
  } finally {
    await page.close();
  }
}, 30_000);

test("on a phone the document scrolls: the TOC strip stays in view and follows the reading position", async () => {
  const page = await open("", { width: 390, height: 844 });
  try {
    await page.getByRole("button", { name: "Topic 0", exact: false }).first().click();
    const active = page.locator('.help-article-toc button[aria-current="location"]');
    await active.waitFor();
    expect(await active.getAttribute("title")).toBe("Section 0");
    // Below md, Layout's main does not scroll; the document does.
    expect(await page.locator(".layout-content-main").evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.waitForFunction(
      () => document.querySelector('.help-article-toc button[aria-current="location"]')?.getAttribute("title") !== "Section 0",
    );
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBeGreaterThanOrEqual(2000);
    const rect = await page.locator(".help-article-toc").boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(844);
  } finally {
    await page.close();
  }
}, 30_000);

test("an embedded reader in a narrow pane uses one column in a wide window", async () => {
  const page = await open("?embedded");
  try {
    await page.getByRole("button", { name: "Topic 0", exact: false }).first().click();
    await page.locator(".help-article-toc button").first().waitFor();
    const layout = await page.locator(".help-article-layout").evaluate((element) => {
      const toc = element.querySelector(".help-article-toc")!.getBoundingClientRect();
      const copy = element.querySelector(".help-article-copy")!.getBoundingClientRect();
      return { columns: getComputedStyle(element).gridTemplateColumns.split(" ").length, tocBottom: toc.bottom, copyTop: copy.top };
    });
    expect(layout.columns).toBe(1);
    expect(layout.tocBottom).toBeLessThanOrEqual(layout.copyTop);
  } finally {
    await page.close();
  }
}, 30_000);

test("typing keeps the same focused search input at the same position and reserves the result region", async () => {
  const page = await open();
  try {
    const input = page.locator("[data-help-search]");
    await input.focus();
    const before = await input.boundingBox();
    const handle = await input.elementHandle();
    await page.keyboard.type("t");
    const after = await input.boundingBox();
    expect(after).toEqual(before);
    expect(
      await handle!.evaluate((element) => element === document.activeElement && element === document.querySelector("[data-help-search]")),
    ).toBe(true);
    expect(await page.locator("[data-help-search]").count()).toBe(1);
    expect(
      await page.locator("[data-help-results]").evaluate((element) => parseFloat(getComputedStyle(element).minHeight)),
    ).toBeGreaterThan(0);
    await input.fill("");
    expect(await page.locator("[data-help-results]").evaluate((element) => element.getAttribute("style") ?? "")).not.toContain(
      "min-height:",
    );
  } finally {
    await page.close();
  }
}, 30_000);
