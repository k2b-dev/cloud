import { describe, expect, test } from "bun:test";
import { Rail } from "@k2b/ui/v2";
import type { Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { installCompactShellHarness, laptop, open } from "./compact-shell.browser-harness";

installCompactShellHarness(launchBrowser);

// The v2 `Rail` is Cloud's app bar in the frame of the Cloud app, so the shell can take it later: at 1440 px it stands
// in the shell's place and every measure and colour equals the shell's rail (v2-rail.css gives it the shell's colours).
const rail = renderToString(() =>
  createComponent(Rail, {
    label: "Cloud",
    logo: "/branding/logo",
    items: [
      { label: "Mail", icon: "mail", href: "/app/mail/inbox", current: true, unread: 3 },
      { label: "Apps", icon: "layout-grid", href: "/apps" },
    ],
    foot: [
      { label: "Search", icon: "search", href: "/search" },
      { label: "Help", icon: "help-circle", href: "/help" },
    ],
  }),
);

type Measure = {
  logo: number[];
  current: number[];
  next: number[];
  footLast: number[];
  railBottom: number;
  radius: string;
  icon: string[];
  badge: number[];
  colors: { currentFill: string; currentInk: string; quiet: string; hoverFill: string; hoverInk: string };
};

/** Every measure of one rail in the page, as boxes `[x, y, width, height]` rounded to 1/100 px. */
const measure = (page: Page, kind: "shell" | "rail"): Promise<Measure> =>
  page.evaluate(async (kind) => {
    const shell = kind === "shell";
    const root = document.querySelector<HTMLElement>(shell ? ".layout-rail" : ".k2-rail")!;
    const box = (element: Element) => {
      const r = element.getBoundingClientRect();
      return [r.left, r.top, r.width, r.height].map((value) => Math.round(value * 100) / 100);
    };
    const items = [...root.querySelectorAll<HTMLElement>(shell ? ".layout-rail-navigation .rail-item" : ".k2-rail-item")];
    const current = items.find((item) => item.getAttribute("aria-current") === "page")!;
    const next = items[items.indexOf(current) + 1]!;
    const foot = shell
      ? [...root.querySelectorAll<HTMLElement>(".layout-rail-actions > :is(button, a, .layout-profile-preferences)")]
      : [...root.querySelectorAll<HTMLElement>(".k2-rail-foot .k2-rail-item")];
    // the shell's count arrives from its route; the probe takes its place on the same corner, with the same class
    let badge: Element;
    if (shell) {
      badge = document.createElement("span");
      badge.className = "cloud-app-badge";
      badge.textContent = "3";
      current.append(badge);
    } else badge = current.querySelector(".k2-unread")!;
    const style = (element: Element) => getComputedStyle(element);
    const icon = style(current.querySelector(shell ? "i" : ".k2-icon")!);
    const quietIcon = next.querySelector(shell ? "i" : ".k2-icon")!;
    const colors = { currentFill: style(current).backgroundColor, currentInk: icon.color, quiet: style(quietIcon).color };
    return {
      logo: box(root.querySelector(shell ? ".layout-rail-logo img" : ".k2-rail-logo > img")!),
      current: box(current),
      next: box(next),
      footLast: box(foot.at(-1)!),
      railBottom: Math.round(root.getBoundingClientRect().bottom * 100) / 100,
      radius: style(current).borderRadius,
      icon: [icon.fontSize, icon.lineHeight],
      badge: (() => {
        const [x, y, width, height] = box(badge);
        const [cx, cy] = box(current);
        return [x! - cx!, y! - cy!, width!, height!];
      })(),
      colors: { ...colors, hoverFill: "", hoverInk: "" },
    };
  }, kind);

/** The fill and ink of the quiet place under the pointer. */
const hovered = async (page: Page, selector: string) => {
  const target = page.locator(selector).first();
  await target.hover();
  // the shell eases its fill in 150 ms; the harness turns transitions off
  await settled(page);
  return target.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fill: style.backgroundColor, ink: style.color };
  });
};

describe("Rail", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`at 1440 px in ${theme} it is the shell's app bar: places, logo, foot, counts and colours`, async () => {
      const { context, page } = await open(laptop, "/app/mail/inbox", { theme });
      try {
        await settled(page);
        const shell = await measure(page, "shell");
        shell.colors.hoverFill = (await hovered(page, ".layout-rail-navigation .rail-item:not(.rail-item-active)")).fill;
        shell.colors.hoverInk = (await hovered(page, ".layout-rail-navigation .rail-item:not(.rail-item-active)")).ink;
        // the rail in the shell rail's box, on the same canvas, as the frame of the Cloud app places it
        const at = await page.evaluate((markup) => {
          const own = document.querySelector<HTMLElement>(".layout-rail")!;
          const r = own.getBoundingClientRect();
          own.style.visibility = "hidden";
          const host = document.createElement("div");
          host.className = "k2-ui";
          host.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;display:flex;`;
          host.innerHTML = markup;
          document.body.append(host);
          // settled: the shell's box is read before the rail is placed, in the page already settled above
          return [r.left, r.top, r.width, r.height];
        }, rail);
        // the pointer leaves the place it hovered in the shell, where the rail's own place now stands
        await page.mouse.move(700, 450);
        await settled(page);
        expect(at).toEqual([0, 8, 56, 884]);
        const own = await measure(page, "rail");
        own.colors.hoverFill = (await hovered(page, ".k2-rail-item:not([aria-current])")).fill;
        own.colors.hoverInk = (await hovered(page, ".k2-rail-item:not([aria-current])")).ink;
        expect(own).toEqual(shell);
        // the shell's own numbers, so a change on either side is seen here
        expect(own.current).toEqual([6, 62, 44, 44]);
        expect(own.next).toEqual([6, 110, 44, 44]);
        expect(own.logo).toEqual([18, 21, 20, 20]);
        expect(own.footLast[1]! + own.footLast[3]!).toBe(own.railBottom);
      } finally {
        await context.close();
      }
    }, 60_000);
  }
});
