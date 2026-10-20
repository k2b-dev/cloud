import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import type { Browser, BrowserContextOptions, Frame, Page } from "playwright";
import { browserName, launchBrowser, settled } from "../../../ui/test/browser";
import { helpPanelServerBrowserFixture, panelGeometry } from "./LayoutHelpPanel.server.browser-harness";

setDefaultTimeout(30_000);
let browser: Browser;
let fixture: Awaited<ReturnType<typeof helpPanelServerBrowserFixture>>;
beforeAll(async () => {
  fixture = await helpPanelServerBrowserFixture();
  browser = await launchBrowser();
}, 60_000);
afterAll(async () => {
  await browser?.close();
  fixture?.cleanup();
});

/** PanelRuntime reloads once for a new timezone cookie; pin both, so the first document is the one measured. */
async function newContext(options: BrowserContextOptions) {
  const context = await browser.newContext({ ...options, timezoneId: "UTC" });
  await context.addCookies([{ name: "cloud.timezone", value: "UTC", url: fixture.origin }]);
  return context;
}

async function holdChunks(page: Page, chunks: string[]) {
  let release = () => {};
  let requested = () => {};
  const held = new Promise<void>((done) => {
    release = done;
  });
  const firstRequest = new Promise<void>((done) => {
    requested = done;
  });
  const pending = new Set<string>();
  await page.route("**/*.js", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (chunks.includes(name)) {
      pending.add(name);
      requested();
      await held;
    }
    await route.continue();
    pending.delete(name);
  });
  return { release, firstRequest, pending };
}
const provider = async (page: Page): Promise<Frame> => {
  await page.locator('iframe[title="Help"]').waitFor();
  const frame = await page
    .locator('iframe[title="Help"]')
    .elementHandle()
    .then((element) => element?.contentFrame());
  if (!frame) throw new Error("Missing provider frame");
  return frame;
};
const mounted = (frame: Frame) =>
  frame.waitForFunction((ids) => ids.every((id) => document.documentElement.dataset[`mounted${id}`] === "true"), fixture.ids);
const ready = (frame: Frame) => frame.waitForFunction(() => document.documentElement.dataset.cloudPanelReady === "fixture");

for (const [width, height] of [
  [1440, 900],
  [834, 1194],
  [390, 844],
] as const) {
  for (const article of [false, true])
    test(`${browserName} ${width}: ${article ? "article" : "start"} is ready and stable with all on-demand chunks held`, async () => {
      const context = await newContext({ viewport: { width, height }, locale: "en", reducedMotion: "reduce" });
      const page = await context.newPage();
      const held = await holdChunks(page, fixture.dynamicChunks);
      try {
        await page.goto(`${fixture.origin}/${article ? "?topic=share" : ""}`, { waitUntil: "domcontentloaded" });
        const frame = await provider(page);
        await ready(frame);
        await mounted(frame);
        await held.firstRequest;
        expect(await frame.locator(article ? "[data-help-server-article]" : "[data-help-tasks]").isVisible()).toBe(true);
        // settled: action chunks are deliberately held; the first server frame is the assertion subject.
        const server = await frame.evaluate(() => JSON.parse(document.documentElement.dataset.serverGeometry ?? "null"));
        expect(await frame.evaluate(panelGeometry)).toEqual(server);
        const finished = page.waitForResponse((response) =>
          fixture.dynamicChunks.includes(new URL(response.url()).pathname.split("/").at(-1) ?? ""),
        );
        held.release();
        await finished;
        await settled(page);
        expect(await frame.evaluate(panelGeometry)).toEqual(server);
        expect(await frame.locator("[data-help-search]").count()).toBe(1);
      } finally {
        held.release();
        await page.unrouteAll({ behavior: "wait" });
        await context.close();
      }
    });
}

test(`${browserName}: typing while search loads preserves the static field, text, focus, caret and reserved height`, async () => {
  const context = await newContext({ viewport: { width: 390, height: 844 }, locale: "en", reducedMotion: "reduce" });
  const page = await context.newPage();
  const held = await holdChunks(page, fixture.searchChunks);
  try {
    await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
    const frame = await provider(page);
    await ready(frame);
    await mounted(frame);
    const input = frame.locator("[data-help-search]");
    await input.focus();
    await frame.waitForFunction(() => document.activeElement === document.querySelector("[data-help-search]"));
    const before = await input.boundingBox();
    await input.fill("Share");
    await input.evaluate((element) => {
      if (element instanceof HTMLInputElement) element.setSelectionRange(2, 2);
    });
    await held.firstRequest;
    expect(await input.inputValue()).toBe("Share");
    expect(await frame.locator("[data-help-tasks]").isVisible()).toBe(true);
    const reserved = await frame
      .locator("[data-help-results]")
      .evaluate((element) => (element instanceof HTMLElement ? element.style.minHeight : ""));
    expect(Number.parseFloat(reserved)).toBeGreaterThan(0);
    held.release();
    await frame.locator("[data-help-search-results]").waitFor();
    expect(await input.boundingBox()).toEqual(before);
    expect(await input.inputValue()).toBe("Share");
    expect(
      await input.evaluate((element) => ({
        focused: document.activeElement === element,
        caret: element instanceof HTMLInputElement ? element.selectionStart : null,
      })),
    ).toEqual({ focused: true, caret: 2 });
    expect(
      await frame.locator("[data-help-results]").evaluate((element) => (element instanceof HTMLElement ? element.style.minHeight : "")),
    ).toBe(reserved);
  } finally {
    held.release();
    await page.unrouteAll({ behavior: "wait" });
    await context.close();
  }
});

for (const activation of ["click", "Enter", " ", "ArrowDown", "ArrowUp"])
  test(`${browserName}: first menu ${activation} opens with focus inside and copies Markdown`, async () => {
    const context = await newContext({ viewport: { width: 834, height: 1194 }, locale: "en", reducedMotion: "reduce" });
    if (browserName === "chromium") await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const page = await context.newPage();
    const held = await holdChunks(page, fixture.menuChunks);
    try {
      await page.goto(`${fixture.origin}/?topic=share`, { waitUntil: "domcontentloaded" });
      const frame = await provider(page);
      await ready(frame);
      await mounted(frame);
      if (browserName === "webkit") {
        // Same WebKit clipboard seam as message-row.browser.test.ts: observe the write at the native item press.
        await frame.evaluate(() =>
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
              writeText: async (text: string) => {
                document.documentElement.dataset.copied = text;
              },
            },
          }),
        );
      }
      const trigger = frame.locator("[data-help-menu]");
      if (activation === "click") await trigger.click();
      else {
        await trigger.focus();
        await trigger.press(activation === " " ? "Space" : activation);
      }
      await held.firstRequest;
      held.release();
      await frame.waitForFunction(
        () =>
          document.activeElement?.closest('[role="menu"]') !== null &&
          document.querySelector('[data-help-menu][aria-expanded="true"]') !== null,
      );
      const copy = frame.getByRole("menuitem", { name: "Copy as Markdown", exact: true });
      if (activation === "ArrowUp")
        expect(
          await frame
            .getByRole("menuitem", { name: "Open as page", exact: true })
            .evaluate((element) => element === document.activeElement),
        ).toBe(true);
      else expect(await copy.evaluate((element) => element === document.activeElement)).toBe(true);
      await copy.click();
      await frame.waitForFunction(() => document.body.textContent?.includes("Article copied"));
      const text =
        browserName === "webkit"
          ? await frame.evaluate(() => document.documentElement.dataset.copied)
          : await frame.evaluate(() => navigator.clipboard.readText());
      expect(text).toContain("Share a Space");
      expect(text).toContain("Invite people.");
    } finally {
      held.release();
      await page.unrouteAll({ behavior: "wait" });
      await context.close();
    }
  });

for (const [entry, selector, focus] of [
  ["HelpPanelMenu.island.tsx", "[data-help-menu]", "menu"],
  ["HelpPanelView.island.tsx", '[data-help-view] [data-help-topic="share"]', "view row"],
  ["HelpPanelBack.island.tsx", ".help-head-back", "back"],
] as const)
  test(`${browserName}: focus on the server ${focus} survives its island mount`, async () => {
    const context = await newContext({ viewport: { width: 834, height: 1194 }, locale: "en", reducedMotion: "reduce" });
    const page = await context.newPage();
    const chunk = fixture.islandChunks.get(entry);
    if (!chunk) throw new Error(`Missing island ${entry}`);
    const held = await holdChunks(page, [chunk]);
    try {
      await page.goto(`${fixture.origin}/${focus === "back" ? "?topic=share" : ""}`, { waitUntil: "domcontentloaded" });
      const frame = await provider(page);
      await ready(frame);
      await held.firstRequest;
      await frame.locator(selector).focus();
      held.release();
      await mounted(frame);
      expect(await frame.locator(selector).evaluate((element) => document.activeElement === element)).toBe(true);
    } finally {
      held.release();
      await page.unrouteAll({ behavior: "wait" });
      await context.close();
    }
  });
