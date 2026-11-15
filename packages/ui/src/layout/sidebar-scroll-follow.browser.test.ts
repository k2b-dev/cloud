import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";

// A page swap inserts server sidebars whose inline scroll script never runs. Whether the current item comes into
// view without moving the page, and whether the offset is stored on leave, depends on real layout.
const entry = resolve(import.meta.dir, "sidebar-scroll-follow.fixture.ts");
const fixture = `
import { followSidebarScroll } from ${JSON.stringify(resolve(import.meta.dir, "sidebar-scroll-memory.ts"))};
import { scrollFadeEdges } from ${JSON.stringify(resolve(import.meta.dir, "scroll-fade.ts"))};
window.follow = () => { window.stopFollow = followSidebarScroll(document, scrollFadeEdges); };
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the sidebar scroll fixture for the browser.");
const script = await build.outputs[0]!.text();
const items = Array.from(
  { length: 30 },
  (_, index) => `<a href="#${index}" style="display:block;height:30px"${index === 25 ? ' aria-current="page"' : ""}>Item ${index}</a>`,
).join("");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

test("a swapped sidebar shows its current item without moving the page, and stores its offset on leave", async () => {
  const page = await browser.newPage({ viewport: { width: 1024, height: 600 } });
  try {
    // sessionStorage needs a real origin, not about:blank.
    await page.route("http://sidebar.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body:
          `<!doctype html><html><body style="margin:0"><div style="height:2000px">` +
          `<nav class="k2b-app-workspace__sidebar-body" data-scroll-preserve="tools-sidebar" style="position:sticky;top:0;height:120px;overflow:auto">${items}</nav>` +
          `</div></body></html>`,
      }),
    );
    await page.goto("http://sidebar.test/tools");
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.scrollTo(0, 400));
    const result = await page.evaluate(() => {
      (window as unknown as { follow: () => void }).follow();
      const body = document.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-body")!;
      const box = body.getBoundingClientRect();
      const item = body.querySelector<HTMLElement>('[aria-current="page"]')!.getBoundingClientRect();
      return {
        visible: item.top >= box.top && item.bottom <= box.bottom,
        windowScroll: window.scrollY,
        fade: body.getAttribute("data-scroll-fade"),
        offset: body.scrollTop,
      };
    });
    expect(result).toMatchObject({ visible: true, windowScroll: 400, fade: "both" });
    expect(result.offset).toBeGreaterThan(0);
    const stored = await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      return sessionStorage.getItem(`k2b-sidebar-scroll:tools-sidebar:1`);
    });
    expect(stored).toBe(String(result.offset));
    const afterCleanup = await page.evaluate(() => {
      (window as unknown as { stopFollow: () => void }).stopFollow();
      document.querySelector<HTMLElement>(".k2b-app-workspace__sidebar-body")!.scrollTop = 0;
      window.dispatchEvent(new PageTransitionEvent("pagehide"));
      return sessionStorage.getItem(`k2b-sidebar-scroll:tools-sidebar:1`);
    });
    expect(afterCleanup).toBe(String(result.offset));
  } finally {
    await page.close();
  }
});
