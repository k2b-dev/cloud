import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchBrowser } from "../../../ui/test/browser";
import { layoutProblems } from "../../../ui/test/head-overlap";
import { installFlatShellHarness, openFlatShell } from "./flat-shell.browser-harness";

installFlatShellHarness(launchBrowser);

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
// scrolls sideways, at every version (phone, tablet, laptop, wide), on the invented Spaces, Files, Notebooks, and
// Mail pages.
for (const name of ["spaces", "files", "notebooks", "mail"])
  for (const width of [390, 768, 1440, 1920])
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
      } finally {
        await page.context().close();
      }
    });
