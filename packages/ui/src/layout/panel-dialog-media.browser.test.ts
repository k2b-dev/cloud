import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Where the header sits over the body is real layout, so the shipped browser build renders here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "panel-dialog-media.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { IconButton, PanelDialog } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const dialog = (id, media) => {
  const host = document.createElement("div");
  host.id = id;
  host.className = "frame";
  render(() => createComponent(PanelDialog, { media, get children() {
    return [
      createComponent(PanelDialog.Header, {
        title: "Beach at dusk with a very long file name that must not push the actions away.jpg",
        subtitle: "2.4 MB · 3 Nov 2026",
        icon: "ti ti-photo",
        close: () => {},
        get actions() { return createComponent(IconButton, { label: "Download", children: "↓" }); },
      }),
      createComponent(PanelDialog.Body, { get children() { const picture = document.createElement("div"); picture.className = "picture"; return picture; } }),
    ];
  } }), host);
  return host;
};
document.getElementById("app").append(dialog("media", true), dialog("plain", false));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the panel dialog fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (options: BrowserContextOptions) => {
  const page = await browser.newPage(options);
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style>` +
      `<style>body{margin:0}.frame{height:420px;display:flex}.picture{flex:1;min-height:300px;background:#0e7490}</style></head>` +
      `<body class="k2b-ui"><main id="app"></main></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("#plain .k2b-panel-dialog__header").waitFor();
  await settled(page);
  return page;
};

const geometry = (page: Awaited<ReturnType<typeof load>>, id: string) =>
  page.evaluate((id) => {
    const root = document.getElementById(id)!;
    const box = (selector: string) => root.querySelector(selector)?.getBoundingClientRect();
    const glass = (selector: string) => root.querySelector(selector)?.classList.contains("k2b-overlay-surface") ?? false;
    const header = box(".k2b-panel-dialog__header")!;
    const body = box(".k2b-panel-dialog__body")!;
    const dialog = box(".k2b-panel-dialog")!;
    const subtitle = root.querySelector<HTMLElement>(".k2b-panel-dialog__heading p");
    return {
      bodyTop: Math.round(body.top - dialog.top),
      headerOverBody: header.bottom > body.top,
      icon: Boolean(root.querySelector(".k2b-panel-dialog__icon")),
      glass: [glass(".k2b-panel-dialog__heading"), glass(".k2b-panel-dialog__actions"), glass(".k2b-dialog__close")],
      actionsInside: box(".k2b-panel-dialog__actions")!.right <= dialog.right && box(".k2b-dialog__close")!.right <= dialog.right,
      headingHeight: Math.round(box(".k2b-panel-dialog__heading")!.height),
      subtitleShown: subtitle ? getComputedStyle(subtitle).display !== "none" : false,
    };
  }, id);

describe("@k2b/ui PanelDialog media", () => {
  test("on a wide screen the header floats over the picture as glass chips; without media nothing changes", async () => {
    const page = await load({ viewport: { width: 1200, height: 900 } });
    try {
      const media = await geometry(page, "media");
      expect(media.bodyTop).toBe(0);
      expect(media.headerOverBody).toBe(true);
      expect(media.icon).toBe(false);
      expect(media.glass).toEqual([true, true, true]);
      expect(media.actionsInside).toBe(true);
      // The title and the facts share one 32 px chip line, however long the name.
      expect(media.headingHeight).toBe(32);
      expect(media.subtitleShown).toBe(true);
      const plain = await geometry(page, "plain");
      expect(plain.bodyTop).toBeGreaterThan(0);
      expect(plain.headerOverBody).toBe(false);
      expect(plain.icon).toBe(true);
      expect(plain.glass).toEqual([false, false, false]);
    } finally {
      await page.close();
    }
  });

  test("on a phone the title chip keeps the name only, and the actions stay in reach", async () => {
    const page = await load({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      const media = await geometry(page, "media");
      expect(media.subtitleShown).toBe(false);
      expect(media.headingHeight).toBe(32);
      expect(media.actionsInside).toBe(true);
    } finally {
      await page.close();
    }
  });
});
