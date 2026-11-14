import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { meterType } from "../../../../scripts/fixtures/type-meter";
import { launchBrowser, settled } from "../../test/browser";

// A card with actions above a pill in a page footer, as on a page an automation serves: it opens on a press only,
// takes the focus, and in every window stays inside the visible area above the pill with its title and last line.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const entry = resolve(import.meta.dir, "hover-card-actions.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { DescriptionList, HoverCard } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const facts = () => {
  const list = document.createElement("div");
  list.className = "facts";
  for (const [term, value] of [
    ["Belongs to", "Lea Muster"], ["Automation", "Delivery notes, version 5"], ["On since", "Nov 12, 09:41"],
    ["Approved by", "Jana Probe"], ["Cloud passes on", "Name, user name, and groups of your account"],
    ["Checked by Cloud", "Whether this version may run, and that the page uses only building blocks."],
    ["Not checked", "What the page shows, whom it lets in, and what happens with your input."],
    ["No passwords", "This page is not a sign-in of Cloud."],
  ]) {
    const row = document.createElement("p");
    row.className = "fact";
    row.textContent = term + ": " + value;
    list.append(row);
  }
  const open = document.createElement("a");
  open.href = "#automation";
  open.id = "open-automation";
  open.textContent = "Open automation";
  list.append(open);
  return list;
};
// Reporting replaces the link with a word, so the focused action leaves the card.
const report = () => {
  const wrap = document.createElement("span");
  const link = document.createElement("a");
  link.href = "#report";
  link.id = "report";
  link.textContent = "Report page";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    wrap.textContent = "Reported";
  });
  wrap.append(link);
  return wrap;
};
render(
  () => [
    createComponent(HoverCard.Trigger, {
      id: "pill",
      "aria-label": "About this page",
      title: "Page of Lea Muster",
      detail: "Example Cloud",
      side: "above",
      align: "end",
      width: "23rem",
      get content() { return facts(); },
      get actions() { return report(); },
      hint: "Made with feat/code",
      children: "Page of Lea Muster",
    }),
    createComponent(HoverCard.Trigger, {
      id: "plain",
      "aria-label": "Plain card",
      title: "Only information",
      content: "No actions here.",
      children: "Plain",
    }),
  ],
  document.getElementById("footer"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the hover card actions fixture for the browser.");
const script = await build.outputs[0]!.text();

const html =
  "<!doctype html><html lang='en'><head><meta name='viewport' content='width=device-width, initial-scale=1'>" +
  `<style>${css}</style><style>${fonts}</style><style>
    body { margin: 0; }
    main { height: 2000px; }
    #footer { position: fixed; inset: auto 0 0 0; height: 44px; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 0 16px; background: var(--k2b-surface); }
    #pill { height: 28px; padding: 0 12px; border-radius: 999px; background: var(--k2b-surface-muted); font-size: 12px; }
    #plain { height: 28px; }
    .fact { margin: 0 0 8px; }
  </style></head><body class="k2b-ui" data-theme="light"><main><a id="top" href="#top">Page</a></main><div id='footer'></div></body></html>`;

setDefaultTimeout(30_000);
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async (options: BrowserContextOptions) => {
  const page = await (await browser.newContext(options)).newPage();
  await page.route(`${assets}**`, (route) =>
    route.fulfill({
      path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)),
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.setContent(html);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};
const card = "#pill + .k2b-hover-card";
const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const { top, left, right, bottom, width, height } = node.getBoundingClientRect();
      return { top, left, right, bottom, width, height };
    });
const isOpen = (page: Page, selector = card) => page.locator(selector).evaluate((node) => node.matches(":popover-open"));

const windows: Array<[number, number]> = [
  [1440, 900],
  [1440, 700],
  [1280, 640],
  [1280, 420],
];

describe("HoverCard with actions", () => {
  for (const [width, height] of windows) {
    test(`${width} × ${height}: above the pill, inside the window, title and last line visible`, async () => {
      const page = await load({ viewport: { width, height } });
      try {
        await page.locator("#pill").click();
        await settled(page);
        expect(await isOpen(page)).toBe(true);
        const surface = await box(page, card);
        const pill = await box(page, "#pill");
        expect(surface.bottom).toBe(pill.top - 6);
        expect(surface.right).toBe(pill.right);
        expect(surface.top).toBeGreaterThanOrEqual(8);
        expect(surface.width).toBe(368);
        const title = await box(page, `${card} .k2b-hover-card__title`);
        const foot = await box(page, `${card} .k2b-hover-card__foot`);
        expect(title.top).toBeGreaterThanOrEqual(surface.top);
        expect(foot.bottom).toBeLessThanOrEqual(surface.bottom);
        const body = await page.locator(`${card} .k2b-hover-card__body`).evaluate((node) => ({
          scrolls: node.scrollHeight > node.clientHeight,
          fade: node.getAttribute("data-scroll-fade"),
        }));
        // Only the lowest window is too short for the whole card: then only the body scrolls and fades out below.
        expect(body).toEqual(height === 420 ? { scrolls: true, fade: "bottom" } : { scrolls: false, fade: null });
      } finally {
        await page.context().close();
      }
    });
  }

  for (const height of [844, 667]) {
    test(`390 × ${height}: a tap opens the sheet, at most the window less 3rem, title and last line visible`, async () => {
      const page = await load({ viewport: { width: 390, height }, hasTouch: true, isMobile: true });
      try {
        const pill = await box(page, "#pill");
        await page.touchscreen.tap(pill.left + pill.width / 2, pill.top + pill.height / 2);
        await settled(page);
        expect(await isOpen(page)).toBe(true);
        expect(await page.locator(card).getAttribute("data-sheet")).toBe("");
        const surface = await box(page, card);
        expect([surface.left, surface.width, surface.bottom]).toEqual([0, 390, height]);
        expect(surface.height).toBeLessThanOrEqual(height - 48);
        expect((await box(page, `${card} .k2b-hover-card__title`)).top).toBeGreaterThanOrEqual(surface.top);
        expect((await box(page, `${card} .k2b-hover-card__foot`)).bottom).toBeLessThanOrEqual(surface.bottom);
      } finally {
        await page.context().close();
      }
    });
  }

  // Evidence for reviews: K2B_HOVER_CARD_SCREENSHOTS=<dir> writes the open card in a tall, a low, and a phone window.
  const shots = process.env.K2B_HOVER_CARD_SCREENSHOTS;
  test.if(Boolean(shots))("screenshots of the open card", async () => {
    mkdirSync(shots!, { recursive: true });
    for (const [width, height, touch] of [
      [1440, 900, false],
      [1280, 420, false],
      [390, 844, true],
    ] as const) {
      const page = await load({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
      try {
        const pill = await box(page, "#pill");
        if (touch) await page.touchscreen.tap(pill.left + pill.width / 2, pill.top + pill.height / 2);
        else await page.locator("#pill").click();
        await settled(page);
        await page.screenshot({ path: `${shots}/hover-card-${width}x${height}.png` });
      } finally {
        await page.context().close();
      }
    }
  });

  test("pointing opens nothing; a press opens a dialog with the focus inside, Escape returns it to the pill", async () => {
    const page = await load({ viewport: { width: 1440, height: 900 } });
    try {
      const trigger = page.locator("#pill");
      expect(await trigger.getAttribute("aria-haspopup")).toBe("dialog");
      expect(await trigger.getAttribute("aria-describedby")).toBeNull();
      await trigger.hover();
      await page.waitForTimeout(700);
      expect(await isOpen(page)).toBe(false);
      await trigger.click();
      await settled(page);
      expect(await isOpen(page)).toBe(true);
      expect(await page.locator(card).getAttribute("role")).toBe("dialog");
      expect(await page.locator(card).getAttribute("aria-labelledby")).toBe(
        await page.locator(`${card} .k2b-hover-card__title`).getAttribute("id"),
      );
      expect(await page.evaluate((selector) => document.querySelector(selector)!.contains(document.activeElement), card)).toBe(true);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("open-automation");
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("report");
      // Moving the pointer away keeps a dialog open.
      await page.mouse.move(10, 10);
      await page.waitForTimeout(400);
      expect(await isOpen(page)).toBe(true);
      await page.keyboard.press("Escape");
      expect(await isOpen(page)).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("pill");
      await page.keyboard.press("Enter");
      await settled(page);
      expect(await isOpen(page)).toBe(true);
      // A press outside closes it.
      await page.mouse.click(300, 300);
      expect(await isOpen(page)).toBe(false);
    } finally {
      await page.context().close();
    }
  });

  test("keyboard: focus on the pill opens nothing, Space opens, a second press closes, Tab beyond the card closes it", async () => {
    const page = await load({ viewport: { width: 1440, height: 900 } });
    try {
      const trigger = page.locator("#pill");
      await page.locator("#top").focus();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("pill");
      await page.waitForTimeout(500);
      expect(await isOpen(page)).toBe(false);
      await page.keyboard.press("Space");
      await settled(page);
      expect(await isOpen(page)).toBe(true);
      await trigger.click();
      expect(await isOpen(page)).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("pill");
      // Tab past the last action moves on to the page and closes the card.
      await page.keyboard.press("Enter");
      await settled(page);
      for (const step of ["open-automation", "report"]) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.id)).toBe(step);
      }
      await page.keyboard.press("Tab");
      expect(await isOpen(page)).toBe(false);
      // Back over the trigger to the page closes it as well.
      await trigger.focus();
      await page.keyboard.press("Enter");
      await settled(page);
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("pill");
      expect(await isOpen(page)).toBe(true);
      await page.keyboard.press("Shift+Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("top");
      expect(await isOpen(page)).toBe(false);
    } finally {
      await page.context().close();
    }
  });

  test("an action that replaces itself loses no focus: Escape still returns it to the pill", async () => {
    const page = await load({ viewport: { width: 1440, height: 900 } });
    try {
      await page.locator("#pill").click();
      await settled(page);
      await page.locator("#report").click();
      expect(await page.locator(`${card} .k2b-hover-card__actions`).textContent()).toBe("Reported");
      expect(await isOpen(page)).toBe(true);
      await page.keyboard.press("Escape");
      expect(await isOpen(page)).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("pill");
    } finally {
      await page.context().close();
    }
  });

  test("a card without actions keeps its hint behaviour: pointing opens it as a tooltip", async () => {
    const page = await load({ viewport: { width: 1440, height: 900 } });
    try {
      await page.locator("#plain").hover();
      await page.waitForFunction(() => document.querySelector("#plain + .k2b-hover-card")!.matches(":popover-open"));
      expect(await page.locator("#plain + .k2b-hover-card").getAttribute("role")).toBe("tooltip");
      expect(await page.locator("#plain").getAttribute("aria-describedby")).not.toBeNull();
      expect(await page.locator("#plain + .k2b-hover-card .k2b-hover-card__foot").count()).toBe(0);
    } finally {
      await page.context().close();
    }
  });

  test("type holds the rule: title 14/600, entries 13/400, last line 12/400", async () => {
    const page = await load({ viewport: { width: 1440, height: 900 } });
    try {
      await page.locator("#pill").click();
      await settled(page);
      const type = await meterType(page, card);
      expect(type.styles).toEqual(["12/400", "13/400", "14/600"]);
      expect(type.offSizes).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
});
