import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { launchBrowser } from "../../test/browser";
import { clientFixture, workspaceCss, workspaceFrames, workspaceGeometry } from "../../test/workspace-host-fixture";

const baselinePath = resolve(import.meta.dir, "workspace-host-regression.baseline.json");
const engine = process.env.TEST_BROWSER ?? "chromium";
const recording = process.env.RECORD_WORKSPACE_BASELINE === "1";
type Shape = ReturnType<typeof workspaceGeometry>;
type Baselines = Record<string, Record<string, Record<string, Shape>>>;
const expected: Baselines = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
const recorded: Baselines[string] = {};
const script = await clientFixture(false);
const css = workspaceCss();
let browser: Browser;
setDefaultTimeout(30_000);
beforeAll(async () => {
  if (!recording && !expected[engine])
    throw new Error(
      `Missing ${engine} workspace baseline. Record origin/main with RECORD_WORKSPACE_BASELINE=1 K2B_UI_DIST=/tmp/workspace-own-width-main-dist TEST_BROWSER=${engine} (run both chromium and webkit).`,
    );
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  if (recording && Object.values(recorded).reduce((count, widths) => count + Object.keys(widths).length, 0) === 20)
    writeFileSync(baselinePath, JSON.stringify({ ...expected, [engine]: recorded }, null, 2) + "\n");
});

for (const scenario of ["open", "closed", "levels", "touch"]) {
  const widths = scenario === "touch" ? [834, 1194] : [1920, 1440, 1194, 1024, 834, 390];
  for (const width of widths) {
    test(`default host parity: ${scenario} at ${width}px`, async () => {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        hasTouch: scenario === "touch",
        reducedMotion: "reduce",
      });
      try {
        await page.setContent(`<!doctype html><html><head><style>${css}</style></head>
          <body class="k2b-ui" style="margin:0"><div id="app" style="height:900px;margin-inline:64px"></div></body></html>`);
        await page.evaluate((scenario) => {
          document.body.dataset.options = JSON.stringify({ scenario });
        }, scenario);
        await page.addScriptTag({ content: script });
        await workspaceFrames(page);
        const shape = await page.evaluate(workspaceGeometry);
        // The added, hidden toggle is not part of origin/main's geometry.
        delete shape.toggle;
        if (recording) (recorded[scenario] ??= {})[width] = shape;
        else {
          const baseline = expected[engine]?.[scenario]?.[width];
          expect(baseline, `Missing ${engine}/${scenario}/${width}; record from origin/main`).toBeDefined();
          expect(Object.keys(shape)).toEqual(Object.keys(baseline!));
          for (const key of Object.keys(shape)) {
            expect(shape[key]!.length, key).toBe(baseline![key]!.length);
            shape[key]!.forEach((actual, index) => {
              const before = baseline![key]![index]!;
              expect(actual.display, key).toBe(before.display);
              for (const dimension of ["x", "y", "width", "height"] as const)
                expect(Math.abs(actual[dimension]! - before[dimension]!), `${key}[${index}].${dimension}`).toBeLessThanOrEqual(0.5);
            });
          }
        }
      } finally {
        await page.close();
      }
    });
  }
}
