import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, BrowserContextOptions, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

// Hover, focus, and touch states come from the shipped stylesheet and the
// engine's media features, which happy-dom does not model.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-checkbox-preview-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Checkbox } = await import("./Checkbox");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const desktop: BrowserContextOptions = { viewport: { width: 800, height: 600 } };
const phone: BrowserContextOptions = { viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

const box = (label: string, props: { value?: boolean; disabled?: boolean } = {}) =>
  renderToString(() => createComponent(Checkbox, { "aria-label": label, value: props.value ?? false, disabled: props.disabled }));

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** A page with an open box, a ticked box, and a disabled open box, without the engine's transitions unless asked. */
const open = async (options: BrowserContextOptions, motion: "reduce" | "no-preference" = "reduce"): Promise<Page> => {
  const page = await browser.newPage({ ...options, reducedMotion: motion });
  await page.setContent(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui"><main style="display:flex;gap:2rem;padding:2rem">` +
      `${box("Open")}${box("Done", { value: true })}${box("Locked", { disabled: true })}</main></body></html>`,
  );
  return page;
};

/** The check of a box: its colour, its scale, and where the box sits. */
const check = (page: Page, label: string) =>
  page.evaluate((name) => {
    const input = document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
    const control = input.nextElementSibling as HTMLElement;
    const icon = control.querySelector("i")!;
    const rect = control.getBoundingClientRect();
    const style = getComputedStyle(icon);
    return {
      color: style.color,
      transform: style.transform,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      transition: `${getComputedStyle(control).transitionDuration} ${style.transitionDuration}`,
    };
  }, label);

const hidden = "rgba(0, 0, 0, 0)";

describe("Checkbox previews ticking", () => {
  test("shows a faint check on an open box under the pointer and with keyboard focus, and moves nothing", async () => {
    const page = await open(desktop);
    try {
      const rest = await check(page, "Open");
      expect(rest.color).toBe(hidden);

      await page.hover('label:has(input[aria-label="Open"])');
      const hovered = await check(page, "Open");
      expect(hovered.color).not.toBe(hidden);
      expect(hovered.color).not.toBe((await check(page, "Done")).color);
      expect(hovered.box).toEqual(rest.box);

      // A disabled box offers nothing to preview.
      await page.hover('label:has(input[aria-label="Locked"])');
      expect((await check(page, "Locked")).color).toBe(hidden);
      expect((await check(page, "Open")).color).toBe(hidden);

      await page.mouse.move(0, 0);
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("Open");
      expect((await check(page, "Open")).color).toBe(hovered.color);

      // Ticked, the check is full and at full size; the box stays where it was.
      await page.keyboard.press("Space");
      const ticked = await check(page, "Open");
      expect(ticked.color).toBe((await check(page, "Done")).color);
      expect(ticked.transform).toBe("none");
      expect(ticked.box).toEqual(rest.box);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("pops the check in when the box is ticked, and keeps it still when the reader asks for less motion", async () => {
    const moving = await open(desktop, "no-preference");
    const still = await open(desktop, "reduce");
    try {
      expect((await check(moving, "Open")).transition).toBe("0.12s, 0.12s, 0.12s 0.2s");
      expect((await check(still, "Open")).transition).toBe("0s 0s");
      // The open box holds its check a little smaller, so ticking grows it into place.
      expect((await check(still, "Open")).transform).not.toBe("none");
    } finally {
      await moving.close();
      await still.close();
    }
  }, 30_000);

  test("takes taps beside a box without label text on a touch screen, and moves nothing", async () => {
    const page = await open(phone);
    try {
      expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
      const rest = await check(page, "Open");
      const { x, y, width, height } = rest.box;
      /** Whether a tap at the point lands on the box with the label, not on what lies around it. */
      const hits = (label: string, px: number, py: number) =>
        page.evaluate(
          ([name, hx, hy]) =>
            document.elementFromPoint(Number(hx), Number(hy))?.closest("label")?.querySelector("input")?.ariaLabel === name,
          [label, px, py] as const,
        );
      // The 44 px touch area reaches 14 px past each edge of the 16 px box; further away a tap misses it.
      expect(await hits("Open", x - 12, y + height / 2)).toBe(true);
      expect(await hits("Open", x + width + 12, y + height / 2)).toBe(true);
      expect(await hits("Open", x + width / 2, y - 12)).toBe(true);
      expect(await hits("Open", x + width / 2, y + height + 12)).toBe(true);
      expect(await hits("Open", x - 18, y + height / 2)).toBe(false);
      await page.touchscreen.tap(x + width / 2, y + height + 12);
      expect(await page.locator('input[aria-label="Open"]').isChecked()).toBe(true);
      expect((await check(page, "Open")).box).toEqual(rest.box);
      // A disabled box takes no taps around it.
      const locked = (await check(page, "Locked")).box;
      expect(await hits("Locked", locked.x - 8, locked.y + locked.height / 2)).toBe(false);

      // A labelled box needs no touch area of its own: its label takes the tap.
      await page.setContent(
        `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui">` +
          renderToString(() => createComponent(Checkbox, { label: "Send a summary", value: false })) +
          "</body></html>",
      );
      const after = await page.evaluate(() => getComputedStyle(document.querySelector(".k2b-check__control")!, "::after").content);
      expect(after).toBe("none");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("keeps a box's own size as its target under a fine pointer", async () => {
    const page = await open(desktop);
    try {
      const { x, y, height } = (await check(page, "Open")).box;
      await page.mouse.click(x - 6, y + height / 2);
      expect(await page.locator('input[aria-label="Open"]').isChecked()).toBe(false);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("does not leave the preview behind after a tap on a touch screen", async () => {
    const page = await open(phone);
    try {
      expect(await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches)).toBe(false);
      const target = page.locator('label:has(input[aria-label="Open"])');
      await target.tap();
      await target.tap();
      // Unticked again with the finger lifted: the box is open and shows no check.
      expect(await page.locator('input[aria-label="Open"]').isChecked()).toBe(false);
      // An engine may keep a tapped element hovered, but hover previews only with a fine pointer; the press preview
      // ends with the press.
      const label = 'label:has(input[aria-label="Open"])';
      await page.waitForFunction((selector) => !document.querySelector(selector)!.matches(":active"), label);
      expect((await check(page, "Open")).color).toBe(hidden);
    } finally {
      await page.close();
    }
  }, 30_000);
});
