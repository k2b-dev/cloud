import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { launchBrowser } from "../../../ui/test/browser";
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
