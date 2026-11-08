import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// A notice row keeps its action beside the text at every width, and a split button opens its menu as a phone sheet.
// Both are questions of real layout, media queries, and popovers, so the shipped browser build renders here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "notice-row.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Button, NoticeCard, SplitButton } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

globalThis.chosen = [];
const items = [
  { sectionLabel: "Load automatically", items: [{ label: "Always from news@example.test", icon: "ti ti-user", action: () => globalThis.chosen.push("sender") }] },
  { label: "Rules for external images…", icon: "ti ti-settings", action: () => globalThis.chosen.push("rules") },
];
const text = (value) => {
  const p = document.createElement("p");
  p.style.cssText = "margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  p.textContent = value;
  return p;
};
const split = (loading = false) =>
  createComponent(SplitButton, {
    variant: "secondary",
    size: "sm",
    loading,
    phone: "sheet",
    menuLabel: "More image options",
    menuNote: "External images can tell the sender when you open the message.",
    items,
    children: "Load images",
  });
const notices = [
  ["split", { tile: "ti ti-photo-shield", tileColor: "rgb(124, 58, 237)", children: text("External images blocked · Protects against tracking when you open the message"), action: split() }],
  ["loading", { tile: "ti ti-photo-shield", tileColor: "rgb(124, 58, 237)", children: text("Loading images…"), action: split(true) }],
  ["danger", { tone: "danger", tile: "ti ti-photo-x", children: text("Images could not be loaded"), action: createComponent(Button, { variant: "secondary", size: "sm", children: "Retry" }) }],
  ["plain", { children: text("Release note"), action: createComponent(Button, { variant: "secondary", size: "sm", children: "Open" }) }],
  ["calm", { title: "Release note", detail: "Version 2.4 is available." }],
];
const app = document.getElementById("app");
for (const [id, props] of notices) {
  const host = document.createElement("div");
  host.id = id;
  render(() => createComponent(NoticeCard, props), host);
  app.append(host);
}
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the notice row fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** A 1440px screen holds a 760px reading pane; a 390px phone uses its whole width. */
const load = async (width: number, phone = false) => {
  const page = await browser.newPage({ viewport: { width, height: 844 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  // A real address, not about:blank: a phone sheet closes through history, which WebKit does not traverse there.
  const html =
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
    `<body class="k2b-ui" style="margin:0"><main id="app" style="display:grid;grid-template-columns:minmax(0,1fr);gap:12px;padding:16px;max-width:760px;box-sizing:border-box"></main></body></html>`;
  await page.route("http://notice.test/", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://notice.test/");
  await page.addScriptTag({ content: script });
  await page.locator("#calm .k2b-notice-card").waitFor();
  await settled(page);
  return page;
};

const measure = (page: Awaited<ReturnType<typeof load>>, id: string) =>
  page.evaluate((id) => {
    const card = document.querySelector(`#${id} .k2b-notice-card`)!;
    const box = (selector: string) => card.querySelector(selector)?.getBoundingClientRect();
    const root = card.getBoundingClientRect();
    const action = box(".k2b-notice-card__action");
    const tile = box(".k2b-notice-card__tile");
    const content = box(".k2b-notice-card__content")!;
    return {
      height: Math.round(root.height),
      tile: tile ? Math.round(tile.width) : null,
      tileLeft: tile ? Math.round(tile.left - root.left) : null,
      textLeft: Math.round(content.left - root.left),
      actionRight: action ? Math.round(root.right - action.right) : null,
      sameLine: action ? Math.abs(action.top + action.height / 2 - (content.top + content.height / 2)) < 1 : null,
      tileColor: tile ? getComputedStyle(card.querySelector(".k2b-notice-card__tile")!).color : null,
    };
  }, id);

describe("@k2b/ui NoticeCard row", () => {
  for (const [width, tile, textLeft] of [
    [1440, 32, 52],
    [390, 28, 46],
  ] as const) {
    test(`on a ${width}px screen a tile and an action keep one 48px row, also while loading`, async () => {
      const page = await load(width);
      try {
        const split = await measure(page, "split");
        expect(split).toMatchObject({ height: 48, tile, tileLeft: 8, textLeft, actionRight: 8, sameLine: true });
        expect(split.tileColor).toBe("rgb(124, 58, 237)");
        expect(await measure(page, "loading")).toMatchObject({ height: 48, tile, textLeft, sameLine: true });
        expect(await measure(page, "danger")).toMatchObject({ height: 48, tile, textLeft, sameLine: true });
        // Without a tile the text starts at the notice's own inset.
        expect(await measure(page, "plain")).toMatchObject({ height: 48, tile: null, textLeft: 14, sameLine: true });
        // A notice without a tile or an action keeps its calm block layout.
        expect(await page.locator("#calm .k2b-notice-card").getAttribute("data-row")).toBeNull();
        expect(await page.evaluate(() => getComputedStyle(document.querySelector("#calm .k2b-notice-card")!).display)).toBe("block");
      } finally {
        await page.close();
      }
    });
  }

  test("the tile is decorative and the action stays reachable by keyboard", async () => {
    const page = await load(1440);
    try {
      expect(await page.locator("#split .k2b-notice-card__tile").getAttribute("aria-hidden")).toBe("true");
      await page.locator("#split").getByRole("button", { name: "Load images" }).focus();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("More image options");
      await page.keyboard.press("Enter");
      await settled(page);
      const menu = page.getByRole("menu", { name: "More image options" });
      expect(await menu.isVisible()).toBe(true);
      // The note describes the menu, so a screen reader hears it once with the menu's name.
      const described = await menu.evaluate((element) =>
        (element.getAttribute("aria-describedby") ?? "")
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent ?? "")
          .join(" "),
      );
      expect(described).toContain("External images can tell the sender when you open the message.");
      expect(await page.locator(".k2b-dropdown__note").first().isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  });
});

describe("@k2b/ui SplitButton phone", () => {
  test("phone sheet opens the menu as a bottom sheet with its note on a phone", async () => {
    const page = await load(390, true);
    try {
      // The truncated text gives way, so the row fits the phone instead of widening the page.
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      await page.locator("#split").getByRole("button", { name: "More image options" }).tap();
      const sheet = page.getByRole("dialog", { name: "More image options" }).last();
      await sheet.waitFor();
      await settled(page);
      expect(await sheet.textContent()).toContain("External images can tell the sender when you open the message.");
      await sheet.getByRole("menuitem", { name: "Always from news@example.test" }).tap();
      await page.waitForFunction(() => (globalThis as unknown as { chosen: string[] }).chosen.length > 0);
      expect(await page.evaluate(() => (globalThis as unknown as { chosen: string[] }).chosen)).toEqual(["sender"]);
    } finally {
      await page.close();
    }
  });

  test("on a wide screen the same split button keeps its menu beside the trigger", async () => {
    const page = await load(1280);
    try {
      await page.locator("#split").getByRole("button", { name: "More image options" }).click();
      await settled(page);
      expect(await page.getByRole("menu", { name: "More image options" }).isVisible()).toBe(true);
      expect(await page.getByRole("dialog").count()).toBe(0);
    } finally {
      await page.close();
    }
  });
});
