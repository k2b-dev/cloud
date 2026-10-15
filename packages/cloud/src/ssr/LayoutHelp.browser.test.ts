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
const open = async (query = "", viewport = { width: 1440, height: 900 }, ready = "[data-help-search]") => {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  await page.route("http://cloud.test/**", (route) => route.fulfill({ contentType: "text/html", body: markup }));
  await page.goto(`http://cloud.test/help/apps/spaces${query}`);
  await page.addScriptTag({ content: bundle });
  await page.locator(ready).waitFor();
  return page;
};

test("wide: a text table of contents stays in view beside the article and follows Layout's page scroller", async () => {
  const page = await open();
  try {
    await page.getByRole("button", { name: "Topic 0", exact: false }).first().click();
    // The frame exists before the body arrives.
    await page.locator(".help-article-layout").waitFor();
    expect(await page.locator("article h3").textContent()).toBe("Topic 0");
    const toc = page.locator(".help-article-aside .k2b-toc");
    const active = toc.locator('a[aria-current="location"]');
    await active.waitFor();
    // Text only: the section titles, no icon tiles.
    expect(await toc.locator("a").allTextContents()).toEqual(Array.from({ length: 8 }, (_, index) => `Section ${index}`));
    expect(await toc.locator("i").count()).toBe(0);
    expect(await page.locator(".help-section-icon, [data-help-icon]").count()).toBe(0);
    expect(await page.locator(".help-article-tools").isVisible()).toBe(false);
    expect(await active.textContent()).toBe("Section 0");
    expect(await page.locator(".cloud-app-canvas").getAttribute("style")).toContain("--app-accent:#16a34a");
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".layout-content-main")!.scrollTop = 2000;
    });
    await page.waitForFunction(() => document.querySelector('.help-article-aside a[aria-current="location"]')?.textContent !== "Section 0");
    const rect = await toc.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(900);
    expect(await page.locator(".layout-content-main").evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(2000);
  } finally {
    await page.close();
  }
}, 30_000);

test("on a phone a short task article shows its access once and its first step without scrolling", async () => {
  const page = await open("", { width: 390, height: 844 });
  try {
    await page.getByRole("button", { name: "Topic 1", exact: false }).first().click();
    const firstStep = page.locator(".help-document .k2b-steps > li").first();
    await firstStep.waitFor();
    // One access chip, and no second "You need" anywhere in the reader's chrome.
    expect(await page.locator(".help-article-fact").allTextContents()).toEqual(["You need Manage", "4 steps"]);
    expect(await page.locator("article").getByText("You need", { exact: false }).count()).toBe(1);
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
    const step = await firstStep.boundingBox();
    expect(step).not.toBeNull();
    expect(step!.y + step!.height).toBeLessThanOrEqual(844);
    expect(await page.locator(".help-article-end .help-article-next").textContent()).toContain("Topic 2");
  } finally {
    await page.close();
  }
}, 30_000);

test("in the Help dialog on a phone a short task article shows its first step without scrolling", async () => {
  const page = await open("?modal", { width: 390, height: 844 });
  try {
    await page.getByRole("dialog").getByRole("button", { name: "Topic 1", exact: false }).first().click();
    const firstStep = page.getByRole("dialog").locator(".help-document .k2b-steps > li").first();
    await firstStep.waitFor();
    const step = await firstStep.boundingBox();
    expect(step).not.toBeNull();
    expect(step!.y).toBeGreaterThanOrEqual(0);
    expect(step!.y + step!.height).toBeLessThanOrEqual(844);
  } finally {
    await page.close();
  }
}, 30_000);

test("compare blocks use two columns on a wide page and one on a phone", async () => {
  for (const [viewport, columns] of [
    [{ width: 1440, height: 900 }, 2],
    [{ width: 390, height: 844 }, 1],
  ] as const) {
    const page = await open("", viewport);
    try {
      await page.getByRole("button", { name: "Topic 1", exact: false }).first().click();
      const compare = page.locator(".help-document .help-compare > ul");
      await compare.waitFor();
      expect(await compare.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(columns);
    } finally {
      await page.close();
    }
  }
}, 30_000);

test("on a phone the table of contents is an On this page menu under the head that follows the reading position", async () => {
  const page = await open("", { width: 390, height: 844 });
  try {
    await page.getByRole("button", { name: "Topic 0", exact: false }).first().click();
    const trigger = page.getByRole("button", { name: "On this page" });
    await trigger.waitFor();
    expect(await page.locator(".help-article-aside").isVisible()).toBe(false);
    const head = await page.locator(".help-article-head h3").boundingBox();
    const menu = await trigger.boundingBox();
    expect(menu!.y).toBeGreaterThan(head!.y);
    // Below md, Layout's main does not scroll; the document does.
    expect(await page.locator(".layout-content-main").evaluate((element) => getComputedStyle(element).overflowY)).toBe("visible");
    await page.evaluate(() => window.scrollTo(0, 2000));
    await page.waitForFunction(() => document.querySelector('.help-article-aside a[aria-current="location"]')?.textContent !== "Section 0");
    // Open the menu where the reader is: a pointer click would first scroll the trigger back into view.
    await trigger.dispatchEvent("click");
    const items = page.getByRole("menuitemradio");
    expect(await items.allTextContents()).toEqual(Array.from({ length: 8 }, (_, index) => `Section ${index}`));
    expect(await page.getByRole("menuitemradio", { name: "Section 0" }).getAttribute("aria-checked")).toBe("false");
    await page.getByRole("menuitemradio", { name: "Section 6" }).click();
    await page.waitForFunction(() => {
      const heading = document.getElementById("section-6")?.getBoundingClientRect();
      return heading !== undefined && heading.top >= -1 && heading.top < 80;
    });
    expect(new URL(page.url()).hash).toBe("#section-6");
  } finally {
    await page.close();
  }
}, 30_000);

test("an embedded reader in a narrow pane uses one column with the menu in a wide window", async () => {
  const page = await open("?embedded");
  try {
    await page.getByRole("button", { name: "Topic 0", exact: false }).first().click();
    await page.getByRole("button", { name: "On this page" }).waitFor();
    const layout = await page.locator(".help-article-layout").evaluate((element) => ({
      columns: getComputedStyle(element).gridTemplateColumns.split(" ").length,
      aside: getComputedStyle(element.querySelector(".help-article-aside")!).display,
    }));
    expect(layout).toEqual({ columns: 1, aside: "none" });
  } finally {
    await page.close();
  }
}, 30_000);

for (const host of ["grids", "pulse"] as const)
  test(`the ${host} query reference shows its article with a text table of contents that follows its scroller`, async () => {
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const page = await open(`?host=${host}`, viewport, ".help-document #section-0");
      try {
        expect(await page.locator("article h3").textContent()).toBe("Topic 0");
        expect(await page.locator(".help-article-toc-icon, .help-section-icon, [data-help-icon]").count()).toBe(0);
        const phone = viewport.width < 768;
        expect(await page.locator(".help-article-aside").isVisible()).toBe(!phone);
        const toc = page.locator(".help-article-aside .k2b-toc");
        expect(await toc.locator("a").allTextContents()).toEqual(Array.from({ length: 8 }, (_, index) => `Section ${index}`));
        expect(await toc.locator("i").count()).toBe(0);
        // The host, not the window, scrolls the article.
        const scroller = await page.locator(".help-article-layout").evaluateHandle((element) => {
          let box = element.parentElement;
          while (box && !(box.scrollHeight > box.clientHeight && /auto|scroll/.test(getComputedStyle(box).overflowY)))
            box = box.parentElement;
          if (!box || box === document.scrollingElement || box === document.body) throw new Error("The host does not scroll the article");
          return box;
        });
        await scroller.evaluate((element) => {
          element.scrollTop = 2000;
        });
        await page.waitForFunction(() => {
          const current = document.querySelector('.help-article-aside a[aria-current="location"]')?.textContent;
          return current !== undefined && current !== "Section 0";
        });
        if (!phone) continue;
        // Open the menu where the reader is: a pointer click would first scroll the trigger back into view.
        await page.getByRole("button", { name: "On this page" }).dispatchEvent("click");
        await page.getByRole("menuitemradio", { name: "Section 6" }).click();
        await page.waitForFunction((element) => {
          const top = document.getElementById("section-6")!.getBoundingClientRect().top - element.getBoundingClientRect().top;
          return top >= -1 && top < 120;
        }, scroller);
      } finally {
        await page.close();
      }
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
