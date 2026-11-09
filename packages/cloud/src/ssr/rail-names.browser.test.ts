import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import {
  attach,
  type Device,
  desktop,
  installCompactShellHarness,
  laptop,
  open,
  phone,
  setRailNames,
} from "./compact-shell.browser-harness";

installCompactShellHarness(launchBrowser);

// The wide app bar is a stylesheet rule on the server-rendered `data-rail-names`, so the server HTML with the global
// stylesheet is the first frame a person sees. The hint and the live switch use `rail-names.ts`, loaded as shipped.
let helpers: string;
beforeAll(async () => {
  const entry = resolve(import.meta.dir, "rail-names.fixture.ts");
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: `import * as railNames from "./rail-names"; window.railNames = railNames;` },
    target: "browser",
    format: "iife",
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not bundle the app bar name helpers.");
  helpers = await bundle.outputs[0]!.text();
});
afterAll(() => setRailNames(false));

declare global {
  interface Window {
    railNames: typeof import("./rail-names");
  }
}

const wide: Device = { name: "wide boundary", width: 1680, height: 1050, touch: false };
const belowWide: Device = { name: "below wide", width: 1679, height: 1050, touch: false };
const longName = "Supplier orders south and north";

const shell = (page: Page) =>
  page.evaluate(() => {
    const rail = document.querySelector<HTMLElement>(".layout-rail")!;
    const style = getComputedStyle(rail);
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
    };
    const label = (element: Element | null) => {
      const text = element?.querySelector(".rail-item-label");
      return text ? { ...box(text), visible: text.getBoundingClientRect().width > 1 } : null;
    };
    return {
      display: style.display,
      rail: box(rail),
      surface: [style.backgroundColor, style.backgroundImage, style.boxShadow, style.borderRightWidth],
      content: box(document.querySelector(".layout-shell-content")!),
      items: [...rail.querySelectorAll(".rail-item")].map((item) => ({
        name: item.getAttribute("aria-label"),
        box: box(item),
        icon: box(item.querySelector(":scope > i")!),
        label: label(item),
      })),
      logo: label(rail.querySelector(".layout-rail-logo")),
      profile: label(rail.querySelector(".layout-profile-preferences__link")),
    };
  });

describe("names in the app bar", () => {
  for (const theme of ["light", "dark"] as const)
    for (const device of [wide, desktop])
      test(`${device.width} px, ${theme}: names beside the icons in a 216 px app bar on the canvas, final in the first frame`, async () => {
        setRailNames(true);
        const { context, page } = await open(device, "/app/mail/inbox?catalog=1", { theme, attached: false });
        try {
          const first = await shell(page);
          expect(first.rail.width).toBe(216);
          expect(first.content.left).toBe(216);
          // No surface, edge, or shadow: the app bar stays on the canvas.
          expect(first.surface).toEqual(["rgba(0, 0, 0, 0)", "none", "none", "0px"]);
          expect(first.items.length).toBeGreaterThanOrEqual(7);
          for (const item of first.items) {
            expect(item.box.height).toBe(40);
            expect(item.box.left).toBe(6);
            expect(item.box.right).toBe(208);
            // Icons keep the column they have in the icon app bar.
            expect(item.icon.left + item.icon.width / 2).toBe(28);
            expect(item.label?.visible).toBe(true);
            expect(item.label!.left).toBe(50);
          }
          expect(first.logo?.visible).toBe(true);
          expect(first.profile?.visible).toBe(true);
          expect(first.profile!.left).toBe(50);
          // The workspace controller attaches after the first paint and changes nothing here.
          await attach(page);
          expect(await shell(page)).toEqual(first);
        } finally {
          await context.close();
        }
      });

  test("below 1680 px, on a phone, and with the setting off, the app bar stays as it was", async () => {
    for (const [device, on, width] of [
      [belowWide, true, 56],
      [laptop, true, 56],
      [desktop, false, 56],
      [phone, true, 0],
    ] as const) {
      setRailNames(on);
      const { context, page } = await open(device, "/app/mail/inbox?catalog=1");
      try {
        const shape = await shell(page);
        if (device === phone) expect(shape.display).toBe("none");
        else {
          expect(shape.rail.width).toBe(width);
          for (const item of shape.items) {
            expect(item.box.width).toBe(44);
            expect(item.label?.visible).toBe(false);
          }
        }
      } finally {
        await context.close();
      }
    }
  });

  test("the hint names an entry only while its name is hidden or cut off", async () => {
    for (const device of [desktop, laptop]) {
      setRailNames(true);
      const { context, page } = await open(device, `/app/mail/inbox?catalog=1&name=${encodeURIComponent(longName)}`);
      try {
        await page.addScriptTag({ content: helpers });
        const clipped = await page.evaluate(() =>
          Object.fromEntries(
            [...document.querySelectorAll(".layout-rail .rail-item")].map((item) => [
              item.querySelector(".rail-item-label")?.textContent,
              window.railNames.railNameClipped(item),
            ]),
          ),
        );
        // Narrow, every name is hidden; wide, only the long one is cut off.
        for (const [name, value] of Object.entries(clipped)) expect([name, value]).toEqual([name, device === laptop || name === longName]);
        const long = await page.evaluate((name) => {
          const label = [...document.querySelectorAll(".layout-rail .rail-item-label")].find((element) => element.textContent === name)!;
          return { overflow: getComputedStyle(label).textOverflow, right: label.getBoundingClientRect().right };
        }, longName);
        if (device === desktop) {
          expect(long.overflow).toBe("ellipsis");
          expect(long.right).toBeLessThanOrEqual(208);
        }
      } finally {
        await context.close();
      }
    }
  });

  test("a count stands at the end of the row and moves no icon or row, also at 99+", async () => {
    setRailNames(true);
    const { context, page } = await open(desktop, "/app/mail/inbox?catalog=1");
    try {
      const result = await page.evaluate(() => {
        const items = [...document.querySelectorAll<HTMLElement>(".layout-rail .rail-item")].filter((item) => item.matches("a"));
        const boxes = () =>
          items.flatMap((item) =>
            [item, item.querySelector(":scope > i")!].map((element) => JSON.stringify(element.getBoundingClientRect())),
          );
        const before = boxes();
        const placed: string[] = [];
        for (const text of ["1", "99+"])
          for (const item of items) {
            item.querySelector(".cloud-app-badge")?.remove();
            item.insertAdjacentHTML("beforeend", `<span class="cloud-app-badge" aria-hidden="true">${text}</span>`);
            const badge = item.querySelector(".cloud-app-badge")!.getBoundingClientRect();
            const row = item.getBoundingClientRect();
            const label = item.querySelector(".rail-item-label")!.getBoundingClientRect();
            if (row.right - badge.right !== 10 || Math.abs(badge.top + badge.height / 2 - (row.top + row.height / 2)) > 0.5)
              placed.push(`${text}: badge not at the row's end`);
            if (label.right > badge.left) placed.push(`${text}: label under the badge`);
          }
        return { moved: boxes().filter((box, index) => box !== before[index]), placed, items: items.length };
      });
      expect(result.items).toBeGreaterThanOrEqual(6);
      expect(result.moved).toEqual([]);
      expect(result.placed).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test("a saved change switches the kept app bar without a reload", async () => {
    setRailNames(true);
    const { context, page } = await open(desktop, "/app/mail/inbox?catalog=1");
    try {
      await page.addScriptTag({ content: helpers });
      const width = () => page.evaluate(() => document.querySelector(".layout-rail")!.getBoundingClientRect().width);
      expect(await width()).toBe(216);
      await page.evaluate(() => window.railNames.syncRailNames(false));
      expect(await width()).toBe(56);
      await page.evaluate(() => window.railNames.syncRailNames(true));
      expect(await width()).toBe(216);
    } finally {
      await context.close();
    }
  });
});
