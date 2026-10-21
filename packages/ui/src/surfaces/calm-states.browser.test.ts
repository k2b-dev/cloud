import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "calm-states.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { AppOverview, Placeholder, Skeleton } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
render(() => createComponent(AppOverview.EmptyState, {title: 'Nothing here yet'}), document.getElementById('overview'));
render(() => createComponent(Placeholder, {surface: 'paper', title: 'No matches', state: 'no-results'}), document.getElementById('workspace'));
const skeletonHost = document.createElement('div');
skeletonHost.id = 'skeleton'; document.body.append(skeletonHost);
render(() => createComponent(Skeleton, {class:'h-10 w-full'}), skeletonHost);
window.retries = 0;
render(() => createComponent(Placeholder, {state: 'error', title: 'Could not load', onRetry: () => { window.retries++; document.body.dataset.retries = String(window.retries); }}), document.getElementById('error'));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle calm states fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

for (const theme of ["light", "dark"])
  test(`calm states have no nested frame and offer recovery in ${theme}`, async () => {
    const page = await (await browser.newContext()).newPage();
    try {
      await page.setContent(
        `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" data-theme="${theme}"><div id="overview"></div><main class="k2b-app-workspace__main"><div id="workspace"></div></main><div id="error"></div></body></html>`,
      );
      await page.addScriptTag({ content: script });
      await settled(page);
      for (const selector of ["#overview .k2b-placeholder", "#workspace .k2b-placeholder"]) {
        const style = await page.locator(selector).evaluate((element) => {
          const s = getComputedStyle(element);
          return {
            background: s.backgroundColor,
            // A border counts when it has width and a visible colour; a paper placeholder in Main keeps a transparent one.
            borders: [
              [s.borderTopWidth, s.borderTopColor],
              [s.borderRightWidth, s.borderRightColor],
              [s.borderBottomWidth, s.borderBottomColor],
              [s.borderLeftWidth, s.borderLeftColor],
            ].map(([width, color]) =>
              width === "0px" || color === "rgba(0, 0, 0, 0)" || color === "transparent" ? "none" : `${width} ${color}`,
            ),
            shadow: s.boxShadow,
          };
        });
        expect(["rgba(0, 0, 0, 0)", "transparent"]).toContain(style.background);
        expect(style.borders).toEqual(["none", "none", "none", "none"]);
        expect(style.shadow).toBe("none");
      }
      const retry = page.getByRole("button", { name: "Try again", exact: true });
      expect(await retry.isVisible()).toBe(true);
      await retry.click();
      expect(await page.locator("body").getAttribute("data-retries")).toBe("1");
    } finally {
      await page.context().close();
    }
  });

test("decorative Skeleton keeps geometry with reduced motion and both themes", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui"><div id="overview"></div><div id="workspace"></div><div id="error"></div></body></html>`,
    );
    await page.addScriptTag({ content: script });
    await settled(page);
    const skeleton = page.locator(".k2b-skeleton");
    const before = await skeleton.boundingBox();
    for (const theme of ["light", "dark"]) {
      await page.locator("body").evaluate((body, theme) => (body.dataset.theme = theme), theme);
      await settled(page);
      const normal = await skeleton.evaluate((e) => ({
        image: getComputedStyle(e).backgroundImage,
        duration: getComputedStyle(e).animationDuration,
        radius: getComputedStyle(e).borderRadius,
      }));
      expect(normal.image).toContain("linear-gradient");
      expect(normal.duration).toBe("1.6s");
      expect(normal.radius).toBe("8px");
      await page.emulateMedia({ reducedMotion: "reduce" });
      await settled(page);
      expect(await skeleton.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
      expect(await skeleton.boundingBox()).toEqual(before);
      expect(await skeleton.getAttribute("aria-hidden")).toBe("true");
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
  } finally {
    await page.close();
  }
});
