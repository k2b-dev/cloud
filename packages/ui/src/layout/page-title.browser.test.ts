import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// `PageTitle` without any host: a standalone SolidJS page publishes its trail,
// and the workspace head and a page's own title follow it. Collapsing a path
// depends on real text widths, so a real engine runs the shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "page-title.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppWorkspace, LocaleProvider, PageTitle, setPageTrail } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const params = new URLSearchParams(window.fixtureParams ?? "");
const levels = ["Projects for the new community centre", "2026 budget year with the second construction phase", "Quotes from all invited suppliers", "Supplier A, Hartmann and Sons, Bremen branch"];
window.publish = (depth) =>
  setPageTrail({ title: depth ? levels[depth - 1] : "Overview", ancestors: levels.slice(0, Math.max(0, depth - 1)).map((title, index) => ({ title, href: "#level-" + index })) });
window.publish(Number(params.get("depth") ?? 0));
const own = () =>
  createComponent(PageTitle, { trail: { title: "Entry", ancestors: levels.map((title, index) => ({ title, href: "#level-" + index })) }, subtitle: "2:15 h" });
const header = document.querySelector("header");
header.style.width = (params.get("own") ?? "0") + "px";
render(
  () =>
    createComponent(LocaleProvider, {
      locale: params.get("locale") ?? "en",
      get children() {
        return params.has("own")
          ? own()
          : createComponent(AppWorkspace, {
              get children() {
                return createComponent(AppWorkspace.Content, {
                  get children() {
                    return createComponent(AppWorkspace.Main, { children: "Content" });
                  },
                });
              },
            });
      },
    }),
  params.has("own") ? header : document.getElementById("app"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the page title fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (width: number, params = "") => {
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>*,*::before,*::after{transition:none!important;animation:none!important}</style></head>` +
      `<body class="k2b-ui" style="margin:0"><header style="display:flex"></header><div id="app" style="height:40rem"></div></body></html>`,
  );
  await page.evaluate((value) => {
    (window as unknown as { fixtureParams: string }).fixtureParams = value;
  }, params);
  await page.addScriptTag({ content: script });
  await settle(page);
  return page;
};
const settle = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const read = (page: Page) =>
  page.evaluate(() => {
    const visible = (element: Element | null | undefined) => !!element && getComputedStyle(element).display !== "none";
    const head = document.querySelector<HTMLElement>(".k2b-app-workspace__head");
    const title = document.querySelector(".k2b-page-title__title");
    const style = head ? getComputedStyle(head) : null;
    return {
      head: style?.display ?? null,
      height: head ? Math.round(head.getBoundingClientRect().height) : 0,
      borders: style ? [style.borderTopWidth, style.borderBottomWidth].join(" ") : "",
      titleTop: title ? Math.round(title.getBoundingClientRect().top) : null,
      title: title?.querySelector(".k2b-page-title__text")?.textContent ?? null,
      back: visible(document.querySelector(".k2b-page-title__up"))
        ? document.querySelector(".k2b-page-title__up")!.getAttribute("aria-label")
        : null,
      crumbs: [...document.querySelectorAll(".k2b-page-title__path > li")].filter(visible).map((item) => item.textContent?.trim()),
    };
  });

describe("PageTitle without a host", () => {
  test("the workspace head follows the published trail and keeps the title in place at every depth", async () => {
    const page = await load(1180);
    try {
      // Nothing above the page: no head on a wide screen.
      expect((await read(page)).head).toBe("none");
      await page.evaluate(() => (window as unknown as { publish: (depth: number) => void }).publish(2));
      await settle(page);
      const two = await read(page);
      expect(two).toMatchObject({
        head: "flex",
        height: 46,
        borders: "0px 0px",
        title: "2026 budget year with the second construction phase",
      });
      expect(two.back).toBe("Back to Projects for the new community centre");
      await page.evaluate(() => (window as unknown as { publish: (depth: number) => void }).publish(4));
      await settle(page);
      const four = await read(page);
      expect(four).toMatchObject({ head: "flex", height: 46, back: null, title: "Supplier A, Hartmann and Sons, Bremen branch" });
      expect(four.crumbs).toEqual([
        "Projects for the new community centre",
        "2026 budget year with the second construction phase",
        "Quotes from all invited suppliers",
      ]);
      expect(four.titleTop).toBe(two.titleTop);
    } finally {
      await page.close();
    }
  });

  test("an app's own title collapses its path by itself and names the menu in the page's language", async () => {
    for (const locale of ["en", "de"] as const) {
      const page = await load(1180, `own=640&locale=${locale}`);
      try {
        const shape = await read(page);
        expect(shape.crumbs[0]).toBe("Projects for the new community centre");
        expect(shape.crumbs).toContain("…");
        expect(shape.crumbs.at(-1)).toBe("Supplier A, Hartmann and Sons, Bremen branch");
        const more = page.locator(".k2b-page-title__more-button");
        expect(await more.getAttribute("aria-label")).toBe(locale === "de" ? "Weitere Ebenen" : "More levels");
        await more.click();
        expect(await page.locator(".k2b-page-title__menu a:visible").allTextContents()).toEqual([
          "2026 budget year with the second construction phase",
          "Quotes from all invited suppliers",
        ]);
        await page.keyboard.press("ArrowDown");
        expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Quotes from all invited suppliers");
        // A wider header shows the whole path again and closes the menu.
        await page.locator("header").evaluate((header) => {
          header.style.width = "1100px";
        });
        await settle(page);
        expect((await read(page)).crumbs).not.toContain("…");
        expect(await page.locator(".k2b-page-title__menu").evaluate((menu) => menu.matches(":popover-open"))).toBe(false);
      } finally {
        await page.close();
      }
    }
  });
});
