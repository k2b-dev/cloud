import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { meterType } from "../../../../scripts/fixtures/type-meter";
import { launchBrowser, settled } from "../../test/browser";

// Run strips, change lists with signs, and tab counts as the Gustav surfaces use them, measured in a real engine.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const icons = readFileSync(resolve(ui, "dist/tabler.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const entry = resolve(import.meta.dir, "marks.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { createSignal } from "solid-js";
import { ChangeList, DotStrip, Tabs } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const [count, setCount] = createSignal("0");
window.__setCount = setCount;
const mount = (id, component, props) => render(() => createComponent(component, props), document.getElementById(id));
mount("bars", DotStrip, { variant: "bar", size: "lg", label: "Last 5 runs: 1 failed",
  dots: ["success", "danger", "muted", "success", "running"],
  links: ["#r1", "#r2", "#r3", "#r4", "#r5"], dotLabels: ["Run 1: succeeded", "Run 2: failed", "Run 3: skipped", "Run 4: succeeded", "Run 5: running"] });
mount("dots", DotStrip, { label: "Last 3 runs", dots: ["success", "danger", "muted"], size: "lg" });
mount("chosen", DotStrip, { label: "Two picked", dots: ["muted", "running", "success"], selected: 0, size: "lg" });
mount("slots", DotStrip, { variant: "slot", label: "Runner: 1 of 3 places taken", dots: ["accent", "muted", "muted"], size: "lg" });
mount("changes", ChangeList, { label: "What changes", marker: "sign", items: [
  { tone: "add", content: "Also runs Mon–Fri at 08:00" },
  { tone: "add", content: "May save files in the folder Delivery notes 2026", marks: [{ label: "needs approval", icon: "ti ti-eye" }] },
  { tone: "remove", content: "May no longer mark conversations", detail: "Version 4 did this." },
  { tone: "same", content: "5 more stay the same." },
] });
mount("tabs", Tabs, { ariaLabel: "Review", value: "overview", onValueChange: () => {}, get options() { return [
  { value: "overview", label: "Overview" },
  { value: "code", label: "Code", count: count(), countReserve: "99" },
  { value: "diff", label: "Diff", count: "+2 −1", countReserve: "+99 −99" },
]; } });
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the marks fixture for the browser.");
const script = await build.outputs[0]!.text();

setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({
      path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)),
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>${fonts}</style><style>${icons}</style>
      <style>body{margin:0} #app{display:grid;gap:24px;padding:16px;justify-items:start}</style></head>
      <body class="k2b-ui" data-theme="light"><div id="app"><div id="bars"></div><div id="dots"></div><div id="slots"></div><div id="chosen"></div><div id="changes"></div><div id="tabs"></div></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.waitForSelector("#changes .k2b-change-list");
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};
const boxes = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((nodes) =>
    nodes.map((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );

// Evidence for reviews: K2B_MARKS_SCREENSHOTS=<dir> writes the fixture at both widths.
const shots = process.env.K2B_MARKS_SCREENSHOTS;
test.if(Boolean(shots))("screenshots of the marks", async () => {
  mkdirSync(shots!, { recursive: true });
  for (const width of [1440, 390]) {
    const page = await open(width);
    try {
      await page.evaluate(() => window.__setCount("3"));
      await settled(page);
      await page.screenshot({ path: `${shots}/marks-${width}.png` });
    } finally {
      await page.close();
    }
  }
});

for (const width of [1440, 390]) {
  describe(`marks at ${width}`, () => {
    test("bars are 5 × 22 px on one base line; a failed run is broken, a skipped one short, and each is a named link", async () => {
      const page = await open(width);
      try {
        const bars = await boxes(page, "#bars .k2b-dot-strip__dot");
        expect(bars.map((bar) => bar.width)).toEqual([5, 5, 5, 5, 5]);
        expect(bars.map((bar) => bar.height)).toEqual([22, 22, 6, 22, 22]);
        expect(new Set(bars.map((bar) => bar.y + bar.height)).size).toBe(1);
        for (let index = 1; index < bars.length; index++) expect(bars[index]!.x - bars[index - 1]!.x).toBe(8);
        // The gap of a failed run is open: no fill behind the broken bar.
        const failed = await page
          .locator('#bars .k2b-dot-strip__dot[data-state="danger"]')
          .evaluate((node) => ({ image: getComputedStyle(node).backgroundImage, fill: getComputedStyle(node).backgroundColor }));
        expect(failed.image).toContain("rgba(0, 0, 0, 0) 36%");
        expect(failed.fill).toBe("rgba(0, 0, 0, 0)");
        expect(await page.locator("#bars .k2b-dot-strip").getAttribute("role")).toBe("list");
        expect(await page.getByRole("link", { name: "Run 2: failed" }).getAttribute("href")).toBe("#r2");
        // One tab stop on the newest run; arrows move between runs.
        await page.locator("#bars a[tabindex='0']").focus();
        expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Run 5: running");
        await page.keyboard.press("ArrowLeft");
        expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Run 4: succeeded");
        await page.keyboard.press("Home");
        expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Run 1: succeeded");
        expect(await page.locator("#bars a[tabindex='0']").count()).toBe(1);
      } finally {
        await page.close();
      }
    });

    test("dots change shape with the state: a circle, a diamond, a ring; places are square", async () => {
      const page = await open(width);
      try {
        const shapes = await page.locator("#dots .k2b-dot-strip__dot").evaluateAll((nodes) =>
          nodes.map((node) => {
            const style = getComputedStyle(node);
            return {
              radius: style.borderRadius,
              rotated: style.transform !== "none",
              filled: style.backgroundColor !== "rgba(0, 0, 0, 0)",
            };
          }),
        );
        expect(shapes[0]).toEqual({ radius: "999px", rotated: false, filled: true });
        expect(shapes[1]).toEqual({ radius: "2px", rotated: true, filled: true });
        expect(shapes[2]).toEqual({ radius: "999px", rotated: false, filled: false });
        // The selection ring wins over the ring of a dot with nothing to do.
        expect(
          await page
            .locator("#chosen .k2b-dot-strip__dot")
            .first()
            .evaluate((node) => getComputedStyle(node).boxShadow),
        ).toContain("3.5px");
        const places = await page
          .locator("#slots .k2b-dot-strip__dot")
          .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).borderRadius));
        expect(new Set(places)).toEqual(new Set(["2px"]));
      } finally {
        await page.close();
      }
    });

    test("a change list with signs keeps one text edge for content, detail, and marks, in the type steps", async () => {
      const page = await open(width);
      try {
        const texts = await boxes(page, "#changes .k2b-change-list__text");
        expect(new Set(texts.map((text) => text.x)).size).toBe(1);
        expect((await boxes(page, "#changes .k2b-change-list__detail"))[0]!.x).toBe(texts[0]!.x);
        const signs = await boxes(page, "#changes .k2b-change-list__icon");
        expect(new Set(signs.map((sign) => sign.x)).size).toBe(1);
        const type = await meterType(page, "#changes", { signs: ".k2b-change-list__icon" });
        expect(type.styles).toEqual(["12/400", "14/400"]);
        expect(type.offSizes).toEqual([]);
        expect(type.axes).toHaveLength(1);
      } finally {
        await page.close();
      }
    });

    test("a tab count keeps its width as the number grows, so no tab moves", async () => {
      const page = await open(width);
      try {
        const before = await boxes(page, "[role=tab]");
        for (const value of ["7", "42", "99"]) {
          await page.evaluate((value) => window.__setCount(value), value);
          await settled(page);
          expect(await boxes(page, "[role=tab]")).toEqual(before);
        }
        expect(
          await page
            .locator(".k2b-tabs__count")
            .first()
            .evaluate((node) => getComputedStyle(node).fontVariantNumeric),
        ).toBe("tabular-nums");
      } finally {
        await page.close();
      }
    });
  });
}

declare global {
  interface Window {
    __setCount: (value: string) => void;
  }
}
