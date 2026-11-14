import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Page } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../../ui/test/browser";
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
const tablet: Device = { name: "tablet", width: 900, height: 1024, touch: false };

/**
 * 8-bit sRGB channels of a computed color, also of Chromium's `color(srgb …)` form of a resolved color-mix(): the
 * screen shows the rounded value, as app-color.ts derives it.
 */
const channels = (color: string): number[] => {
  const srgb = color.match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)/);
  if (srgb) return srgb.slice(1, 4).map((value) => Math.round(Number(value) * 255));
  const rgb = color.match(/^rgba?\(([\d.]+), ([\d.]+), ([\d.]+)/);
  if (rgb) return rgb.slice(1, 4).map(Number);
  throw new Error(`Unsupported color ${color}`);
};
const luminance = (color: string) => {
  const [r, g, b] = channels(color).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};
/** The colors of a computed linear-gradient(): the grounds the app bar lies on. */
const gradientStops = (image: string) => [...image.matchAll(/(?:color\(srgb [^)]+\)|rgba?\([^)]+\))/g)].map((match) => match[0]);

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
        iconColor: getComputedStyle(item.querySelector(":scope > i")!).color,
        label: label(item),
      })),
      logo: label(rail.querySelector(".layout-rail-logo")),
      profile: label(rail.querySelector(".layout-profile-preferences__link")),
    };
  });

describe("names in the app bar", () => {
  for (const theme of ["light", "dark"] as const)
    for (const device of [wide, desktop])
      test(`${device.width} px, ${theme}: names beside the icons in a 208 px app bar on the canvas, final in the first frame`, async () => {
        setRailNames(true);
        const { context, page } = await open(device, "/app/mail/inbox?colors=teal", { theme, attached: false });
        try {
          const first = await shell(page);
          expect(first.rail.width).toBe(208);
          expect(first.content.left).toBe(208);
          // No surface, edge, or shadow: the app bar stays on the canvas.
          expect(first.surface).toEqual(["rgba(0, 0, 0, 0)", "none", "none", "0px"]);
          expect(first.items.length).toBeGreaterThanOrEqual(7);
          for (const item of first.items) {
            // A sidebar row: 32 px, an 11 px inset, a 16 px icon column, and the name 8 px after it.
            expect(item.box.height).toBe(32);
            expect(item.box.left).toBe(11);
            expect(item.box.right).toBe(200);
            // Icons keep the column they have in the icon app bar.
            expect(item.icon.left + item.icon.width / 2).toBe(28);
            expect(item.label?.visible).toBe(true);
            expect(item.label!.left).toBe(44);
          }
          expect(first.logo?.visible).toBe(true);
          expect(first.profile?.visible).toBe(true);
          expect(first.profile!.left).toBe(44);
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

  // `RailItemHint` disables its tooltip with exactly this measure; the server markup here has no islands, so the test
  // checks the measure on the real layout, not the tooltip itself.
  test("an entry's name counts as hidden or cut off exactly where its hint should show", async () => {
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
          expect(long.right).toBeLessThanOrEqual(191);
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
            if (row.right - badge.right !== 9 || Math.abs(badge.top + badge.height / 2 - (row.top + row.height / 2)) > 0.5)
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

  test("a pointer only tints an entry; keyboard focus draws Cloud's shared ring inside it and moves nothing", async () => {
    for (const device of [desktop, laptop]) {
      setRailNames(true);
      const { context, page } = await open(device, "/app/mail/inbox?catalog=1");
      try {
        const look = (selector: string) =>
          page
            .locator(selector)
            .first()
            .evaluate((element) => {
              const style = getComputedStyle(element);
              const probe = document.createElement("span");
              probe.style.color = "var(--k2b-focus-ring)";
              element.append(probe);
              const ring = getComputedStyle(probe).color;
              probe.remove();
              return {
                box: JSON.stringify(element.getBoundingClientRect()),
                edges: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
                outline: [style.outlineStyle, style.outlineWidth, style.outlineColor, style.outlineOffset],
                shadow: style.boxShadow,
                background: style.backgroundColor,
                focused: element.matches(":focus-visible"),
                ring,
              };
            });
        const inactive = ".layout-rail a.rail-item:not(.rail-item-active)";
        const rest = await look(inactive);
        await hoverInPlace(page.locator(inactive).first());
        await settled(page);
        const hovered = await look(inactive);
        expect(hovered.edges).toEqual(["0px", "0px", "0px", "0px"]);
        expect(hovered.outline[0]).toBe("none");
        expect(hovered.background).not.toBe(rest.background);
        expect(hovered.box).toBe(rest.box);
        await page.mouse.move(device.width - 1, device.height - 1);
        await settled(page);
        for (const selector of [
          ".layout-rail-logo > a",
          inactive,
          ".layout-rail a.rail-item-active",
          ".layout-rail [data-cloud-launchpad]",
          ".layout-rail .layout-profile-preferences__link",
        ]) {
          const before = await look(selector);
          await page.keyboard.press("Shift");
          await page.locator(selector).first().focus();
          await settled(page);
          const focused = await look(selector);
          expect([selector, focused.focused]).toEqual([selector, true]);
          expect([selector, ...focused.outline]).toEqual([selector, "solid", "2px", focused.ring, "-2px"]);
          expect([selector, focused.shadow]).toEqual([selector, "none"]);
          expect([selector, focused.box]).toEqual([selector, before.box]);
        }
      } finally {
        await context.close();
      }
    }
  });

  test("a saved change switches the kept app bar without a reload", async () => {
    setRailNames(true);
    const { context, page } = await open(desktop, "/app/mail/inbox?catalog=1");
    try {
      await page.addScriptTag({ content: helpers });
      const width = () => page.evaluate(() => document.querySelector(".layout-rail")!.getBoundingClientRect().width);
      expect(await width()).toBe(208);
      await page.evaluate(() => window.railNames.syncRailNames(false));
      expect(await width()).toBe(56);
      await page.evaluate(() => window.railNames.syncRailNames(true));
      expect(await width()).toBe(208);
    } finally {
      await context.close();
    }
  });
  test("rows take the sidebar's measures, and the open app is its selected row: a tinted fill without an edge", async () => {
    for (const theme of ["light", "dark"] as const) {
      setRailNames(true);
      const { context, page } = await open(desktop, "/app/mail/inbox?colors=teal", { theme });
      try {
        const result = await page.evaluate(() => {
          const look = (element: Element) => {
            const style = getComputedStyle(element);
            return {
              height: element.getBoundingClientRect().height,
              radius: style.borderTopLeftRadius,
              paddingStart: style.paddingInlineStart,
              gap: style.columnGap,
              edges: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
              color: style.color,
              background: style.backgroundColor,
            };
          };
          const text = (element: Element) => {
            const style = getComputedStyle(element);
            return { size: style.fontSize, weight: style.fontWeight, lineHeight: style.lineHeight, color: style.color };
          };
          const row = document.querySelector(".k2b-app-workspace__sidebar-item:not(.is-active)")!;
          const selected = document.querySelector(".k2b-app-workspace__sidebar-item.is-active")!;
          const item = document.querySelector(".layout-rail a.rail-item:not(.rail-item-active)")!;
          const active = document.querySelector(".layout-rail a.rail-item-active")!;
          const icon = (element: Element) => getComputedStyle(element.querySelector(":scope > i")!).fontSize;
          return {
            row: { ...look(row), text: text(row) },
            selected: { ...look(selected), text: text(selected.querySelector(".k2b-app-workspace__sidebar-item-label-text") ?? selected) },
            item: { ...look(item), text: text(item.querySelector(".rail-item-label")!), icon: icon(item) },
            active: {
              ...look(active),
              text: text(active.querySelector(".rail-item-label")!),
              icon: icon(active),
              name: active.getAttribute("aria-label"),
            },
          };
        });
        expect(result.active.name).toBe("Mail");
        for (const key of ["height", "radius", "gap"] as const) expect([key, result.item[key]]).toEqual([key, result.row[key]]);
        expect(result.item.paddingStart).toBe(result.row.paddingStart);
        expect(result.item.text).toEqual(result.row.text);
        expect(result.item.text.size).toBe("13px");
        expect(result.item.text.weight).toBe("400");
        expect(result.item.icon).toBe("15px");
        expect(result.item.background).toBe("rgba(0, 0, 0, 0)");
        // The open app: the sidebar's selection fill and ink, at 600, without the former 1 px box.
        expect(result.active.edges).toEqual(["0px", "0px", "0px", "0px"]);
        expect(result.active.background).toBe(result.selected.background);
        expect(result.active.color).toBe(result.selected.color);
        expect(result.active.text.weight).toBe("600");
        expect(result.active.icon).toBe("15px");
      } finally {
        await context.close();
      }
    }
  });

  test("counts are the sidebar's quiet number on a light ground, at 1, 22, and 99+", async () => {
    setRailNames(true);
    const { context, page } = await open(desktop, "/app/mail/inbox?colors=teal");
    try {
      const result = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.className = "k2b-app-workspace__sidebar-status-count";
        probe.textContent = "1";
        document.querySelector(".k2b-app-workspace__sidebar-item")!.append(probe);
        const sidebar = getComputedStyle(probe);
        const expected = [
          sidebar.color,
          sidebar.backgroundColor,
          sidebar.fontSize,
          sidebar.fontWeight,
          sidebar.height,
          sidebar.borderRadius,
        ];
        probe.remove();
        const items = [...document.querySelectorAll<HTMLElement>(".layout-rail a.rail-item")].slice(0, 3);
        return ["1", "22", "99+"].map((count, index) => {
          items[index]!.insertAdjacentHTML("beforeend", `<span class="cloud-app-badge" aria-hidden="true">${count}</span>`);
          const style = getComputedStyle(items[index]!.querySelector(".cloud-app-badge")!);
          return {
            count,
            look: [style.color, style.backgroundColor, style.fontSize, style.fontWeight, style.height, style.borderRadius],
            expected,
          };
        });
      });
      for (const { count, look, expected } of result) expect([count, look]).toEqual([count, expected]);
    } finally {
      await context.close();
    }
  });

  test("each app's icon has its app's color at 3:1 on every ground of the bar; names and the bar's own controls stay neutral", async () => {
    for (const colors of ["teal", "yellow"] as const)
      for (const theme of ["light", "dark"] as const) {
        const seen = new Map<string, string>();
        for (const [device, names] of [
          [desktop, true],
          [laptop, true],
          [tablet, true],
        ] as const) {
          setRailNames(names);
          const { context, page } = await open(device, `/app/mail/inbox?colors=${colors}`, { theme });
          try {
            const bar = await page.evaluate(() => {
              const rail = document.querySelector(".layout-rail")!;
              const canvas = getComputedStyle(document.querySelector(".cloud-app-canvas")!).backgroundImage;
              const own = getComputedStyle(rail).backgroundImage;
              return {
                grounds: own === "none" ? canvas : own,
                apps: [...rail.querySelectorAll<HTMLElement>("a.rail-item:not(.rail-item-active)")].map((item) => ({
                  name: item.getAttribute("aria-label")!,
                  icon: getComputedStyle(item.querySelector(":scope > i")!).color,
                  text: getComputedStyle(item).color,
                })),
                controls: [...rail.querySelectorAll<HTMLElement>("button.rail-item")].map((item) => ({
                  icon: getComputedStyle(item.querySelector(":scope > i")!).color,
                  text: getComputedStyle(item).color,
                })),
              };
            });
            const grounds = gradientStops(bar.grounds);
            expect(grounds.length).toBe(3);
            expect(bar.apps.length).toBe(7);
            for (const app of bar.apps) {
              // An app color, not the neutral ink of the row.
              expect([app.name, app.icon === app.text]).toEqual([app.name, false]);
              for (const ground of grounds)
                expect([colors, theme, device.name, app.name, app.icon, ground, contrast(app.icon, ground) >= 3]).toEqual([
                  colors,
                  theme,
                  device.name,
                  app.name,
                  app.icon,
                  ground,
                  true,
                ]);
              // One color per app at every width of the same page.
              const before = seen.get(app.name);
              if (before) expect([app.name, app.icon]).toEqual([app.name, before]);
              else seen.set(app.name, app.icon);
            }
            for (const control of bar.controls) expect(control.icon).toBe(control.text);
          } finally {
            await context.close();
          }
        }
      }
  });
});
