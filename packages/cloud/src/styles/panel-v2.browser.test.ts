import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../../ui/test/browser";

// A v2 provider page in the panel (`PanelLayout ui="v2"`): the panel page is the v2 scope on the v2 surface, and its
// text edge is the panel's 16 px at every width of the panel, also from 768 px, where a v2 page elsewhere has 20 px.
let browser: Browser;
let css: string;
beforeAll(async () => {
  const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, "Could not compile the global stylesheet.");
  css = await build.outputs[0]!.text();
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

for (const theme of ["light", "dark"] as const)
  for (const width of [400, 900])
    test(`a v2 panel page keeps the 16 px edge and the v2 surface at ${width} px (${theme})`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      try {
        await page.setContent(
          `<html class="${theme === "dark" ? "dark" : ""}"><head><style>${css}</style></head><body class="k2b-ui">` +
            `<div class="cloud-panel-page k2-ui" data-cloud-panel-page="" data-ui="v2"><p id="edge" style="padding-left: var(--k2-edge)">Text</p></div>` +
            `<div class="k2-ui" id="elsewhere"><p style="padding-left: var(--k2-edge)">Text</p></div>` +
            `</body></html>`,
        );
        await settled(page);
        const result = await page.evaluate(() => {
          const panel = document.querySelector<HTMLElement>("[data-cloud-panel-page]")!;
          const probe = document.createElement("i");
          probe.style.background = "var(--k2-surface)";
          panel.append(probe);
          return {
            edge: getComputedStyle(document.getElementById("edge")!).paddingLeft,
            elsewhere: getComputedStyle(document.querySelector("#elsewhere > p")!).paddingLeft,
            fill: getComputedStyle(panel).backgroundColor,
            surface: getComputedStyle(probe).backgroundColor,
          };
        });
        expect(result.edge).toBe("16px");
        // a v2 page outside the panel keeps its own edge, so the rule is the panel's alone
        expect(result.elsewhere).toBe(width < 768 ? "16px" : "20px");
        expect(result.fill).toBe(result.surface);
      } finally {
        await page.close();
      }
    });
