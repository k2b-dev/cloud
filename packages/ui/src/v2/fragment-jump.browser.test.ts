import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";

// A page opened at a place far down (`/me/access#groups`), or a place brought into view (`scrollIntoView`), scrolls only
// the pane that holds it. The frame around it clips its content, but a box with `overflow: hidden` can still be scrolled
// by the browser's jump: the whole workspace moved up, its sidebar column stood empty, its head was gone and empty room
// stood at the bottom. The frame clips with `overflow: clip`, which nothing can scroll.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss = "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; }";

let browser: Browser;
let html: string;
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-fragment-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-fragment-jump.server.tsx", "ssr"));
  const { render }: { render: () => string } = await import(serverFile);
  html = render();
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

/** The page served at an address of its own, so the browser jumps to its fragment as it would in Cloud. */
const open = async (width: number, address: string): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(2000);
  await page.route("http://frame.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${html}</div></body></html>`,
    }),
  );
  await page.goto(`http://frame.test${address}`);
  await settled(page);
  return page;
};

/** Where the frame stands and what the pane shows. */
const frame = (page: Page) =>
  page.evaluate(() => {
    const scrolled = (selector: string) => document.querySelector(selector)?.scrollTop ?? -1;
    const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const scroll = box(".k2-pane > .k2-scroll");
    const target = box("#deep");
    return {
      // nothing but the pane's own scroll has moved
      frameScrolled: {
        page: document.scrollingElement?.scrollTop ?? 0,
        workspace: scrolled(".k2-ws"),
        side: scrolled(".k2-ws-side"),
        main: scrolled(".k2-ws-main"),
        pane: scrolled(".k2-pane"),
      },
      paneScrolled: scrolled(".k2-pane > .k2-scroll") > 0,
      targetInPane: target.top >= scroll.top && target.bottom <= scroll.bottom,
      // the sidebar and the head stand where they stand on the page before any jump
      side: box(".k2-ws-side").top,
      head: box('.k2-ws-main > [data-slot="head"]').top,
    };
  });

const still = { page: 0, workspace: 0, side: 0, main: 0, pane: 0 };

for (const width of [1024, 1440])
  test(`${width} px: a page opened at a place far down scrolls only its pane`, async () => {
    const before = await open(width, "/me/access");
    const { side, head } = await frame(before);
    await before.close();
    const page = await open(width, "/me/access#deep");
    try {
      expect(await frame(page)).toEqual({ frameScrolled: still, paneScrolled: true, targetInPane: true, side, head });
    } finally {
      await page.close();
    }
  });

test("a place brought into view by a script scrolls only its pane too", async () => {
  const page = await open(1440, "/me/access");
  try {
    const { side, head, paneScrolled } = await frame(page);
    expect(paneScrolled).toBe(false);
    await page.evaluate(() => document.getElementById("deep")?.scrollIntoView({ block: "center" }));
    await settled(page);
    expect(await frame(page)).toEqual({ frameScrolled: still, paneScrolled: true, targetInPane: true, side, head });
  } finally {
    await page.close();
  }
});
