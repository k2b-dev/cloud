import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchBrowser } from "../../../ui/test/browser";
import { layoutProblems } from "../../../ui/test/head-overlap";
import { installFlatShellHarness, openFlatShell } from "./flat-shell.browser-harness";

// Classic visible scrollbars, as a desktop with a mouse draws them: their tracks take room as they do for people.
installFlatShellHarness((options) => launchBrowser({ ...options, ignoreDefaultArgs: ["--hide-scrollbars"] }));

// `FLAT_SHELL_SHOTS=<dir>` also saves light screenshots of the invented pages for review.
const shots = process.env.FLAT_SHELL_SHOTS;
const shotPages = (process.env.FLAT_SHELL_PAGES ?? "spaces").split(",");
const shotWidths = (process.env.FLAT_SHELL_WIDTHS ?? "1440").split(",").map(Number);

test.if(Boolean(shots))("saves screenshots of the invented pages", async () => {
  mkdirSync(shots!, { recursive: true });
  for (const name of shotPages)
    for (const width of shotWidths) {
      const page = await openFlatShell(width, `/app/${name}`, { fonts: true });
      try {
        await page.screenshot({ path: resolve(shots!, `${name.replace(/[^a-z0-9]+/gi, "-")}-${width}.png`) });
      } finally {
        await page.context().close();
      }
    }
  expect(true).toBe(true);
});

// K15 and "one line, one owner" (K2): in the flat shell nothing overlaps, spills, is cut, draws a double line, or
// scrolls sideways, at every version (phone, tablet, a narrow laptop with Detail, laptop, wide), on the invented Spaces,
// Files, Notebooks, and Mail pages. No box draws a border on a column line, which the column's hairline already owns.
for (const name of ["spaces", "files", "notebooks", "mail"])
  for (const width of [390, 768, 1100, 1440, 1920])
    test(`${name} ${width} px: nothing overlaps, spills, is cut, or draws a double line`, async () => {
      // A mouse: a coarse pointer gives icon buttons a 44 px hit area beyond their box on purpose.
      const page = await openFlatShell(width, `/app/${name}`, { touch: false });
      try {
        // The workspace is the subject; the rail's names are visually hidden on purpose below 1680 px. A grip lies over
        // its line by design (K13), and the head's heading and the phone's primary label are visually hidden text.
        const found = await page.evaluate(layoutProblems, {
          root: ".layout-content-main",
          ignore:
            ".k2b-app-workspace__resize, .k2b-app-workspace__head-heading, .k2b-app-workspace__head-primary-label, .k2b-sr-only, [data-layout-check='skip']",
        });
        expect(found.problems).toEqual([]);
        const doubled = await page.evaluate(() => {
          const shown = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).display !== "none";
          // Every drawn column line: after a sidebar column, between panes and levels, and before a Detail column. A
          // phone draws none, an overlay sidebar or a waiting Detail neither.
          const lines: number[] = [];
          if (window.innerWidth >= 768) {
            const left = (element: Element) => element.getBoundingClientRect().left;
            const sidebar = document.querySelector(".k2b-app-workspace__sidebar");
            const content = document.querySelector(".k2b-app-workspace__content");
            if (sidebar && content && shown(sidebar) && Math.abs(sidebar.getBoundingClientRect().right - left(content)) <= 1.5)
              lines.push(left(content));
            lines.push(...[...document.querySelectorAll("[data-workspace-main-region]")].filter(shown).slice(1).map(left));
            const detail = document.querySelector(".k2b-app-workspace__detail:not([data-workspace-detail-drawer])");
            if (detail && shown(detail)) lines.push(left(detail));
          }
          const found: string[] = [];
          for (const element of document.querySelectorAll<HTMLElement>(".layout-content-main .k2b-app-workspace *")) {
            const box = element.getBoundingClientRect();
            if (box.width === 0 || box.height === 0) continue;
            const style = getComputedStyle(element);
            for (const [side, x] of [
              ["Left", box.left],
              ["Right", box.right],
            ] as const) {
              const drawn =
                Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 &&
                style.getPropertyValue(`border-${side.toLowerCase()}-style`) !== "none" &&
                !/rgba\(.*,\s*0\)$|transparent/.test(style.getPropertyValue(`border-${side.toLowerCase()}-color`));
              if (drawn && lines.some((line) => Math.abs(line - x) <= 1.5))
                found.push(
                  `${element.tagName.toLowerCase()}.${element.className.toString().split(" ")[0]} border-${side.toLowerCase()} at ${Math.round(x)}`,
                );
            }
          }
          return found;
        });
        expect(doubled).toEqual([]);
        // K15 (B8, B9): this page is rendered on the server and never hydrated, as the QA measures it. No strip in the
        // head scrolls sideways: a path waits behind "…" and shortens its last level, views move into More. Only the
        // filters scroll, with a fade.
        const sideways = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>(".k2b-app-workspace__head *")]
            .filter((element) => !element.closest(".k2b-app-workspace__head-filters"))
            .filter((element) => getComputedStyle(element).overflowX !== "visible" && element.clientWidth > 1)
            .filter((element) => element.scrollWidth > element.clientWidth + 1)
            .map(
              (element) =>
                `${element.tagName.toLowerCase()}.${element.className.toString().split(" ")[0]} ${element.scrollWidth}/${element.clientWidth}`,
            ),
        );
        expect(sideways).toEqual([]);
      } finally {
        await page.context().close();
      }
    });
