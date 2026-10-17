import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent, createSignal } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";
import {
  type FixtureOptions,
  uiDirectory,
  workspaceCss,
  workspaceDist,
  workspaceGeometry,
  workspaceTree,
} from "../../test/workspace-host-fixture";

const directory = mkdtempSync(resolve(tmpdir(), "k2b-workspace-host-hydration-"));
const { plugin } = createConfig({ dev: true, rootDir: directory });
Bun.plugin(plugin());
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const { default: AppWorkspace } = await import("./AppWorkspace");
const css = workspaceCss();
const entry = resolve(uiDirectory, "src/layout/workspace-host.island-fixture.ts");
// Mirror packages/ssr/src/mount.ts: an island replaces the server markup with a client render.
const result = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
      import { createComponent, Dynamic, render } from "solid-js/web";
      import { createSignal } from "solid-js";
      import { AppWorkspace } from ${JSON.stringify(resolve(workspaceDist, "browser/index.js"))};
      const tree = ${workspaceTree.toString()};
      const measure = ${workspaceGeometry.toString()};
      const island = document.getElementById("island");
      island.innerHTML = "";
      render(() => tree({AppWorkspace, createComponent, createSignal, Dynamic},
        JSON.parse(document.body.dataset.options)), island);
      window.workspaceHostMountedFrame = measure();
      requestAnimationFrame(() => requestAnimationFrame(() => { window.workspaceHostSettledFrame = measure(); }));
    `,
  },
  target: "browser",
  format: "iife",
});
if (!result.success) throw new AggregateError(result.logs, "Could not bundle host hydration fixture");
const script = await result.outputs[0]!.text();
let browser: Browser;
setDefaultTimeout(60_000);
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

for (const [host, scenario] of [
  [1024, "open"],
  [1024, "levels"],
  [860, "open"],
] as const) {
  test(`server frame, first island frame and settled geometry agree at ${host}px (${scenario}), ten reloads`, async () => {
    const options: FixtureOptions = { scenario };
    for (let attempt = 0; attempt < 10; attempt++) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        const html = renderToString(() => workspaceTree({ AppWorkspace, createComponent, createSignal, Dynamic }, options));
        await page.route("http://workspace.test/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><html><head><style>${css}</style></head>
            <body class="k2b-ui" style="margin:0;display:flex" data-options='${JSON.stringify(options)}'>
              <div style="container:k2b-app-area / inline-size;width:${host}px;flex:none">
                <div id="app" style="height:900px;margin-inline:64px"><solid-island id="island" style="display:contents">${html}</solid-island></div>
              </div><div style="flex:1">Host panel</div>
              <script>requestAnimationFrame(() => { window.workspaceHostServerFrame = (${workspaceGeometry.toString()})(); });</script>
            </body></html>`,
          }),
        );
        await page.goto("http://workspace.test/");
        await page.waitForFunction(() => "workspaceHostServerFrame" in window);
        await page.addScriptTag({ content: script });
        await page.waitForFunction(() => "workspaceHostSettledFrame" in window);
        const frames = await page.evaluate(() => {
          const state = window as Window & {
            workspaceHostServerFrame?: ReturnType<typeof workspaceGeometry>;
            workspaceHostMountedFrame?: ReturnType<typeof workspaceGeometry>;
            workspaceHostSettledFrame?: ReturnType<typeof workspaceGeometry>;
          };
          return [state.workspaceHostServerFrame!, state.workspaceHostMountedFrame!, state.workspaceHostSettledFrame!];
        });
        expect(frames[1], `mount #${attempt + 1}`).toEqual(frames[0]);
        expect(frames[2], `settled #${attempt + 1}`).toEqual(frames[0]);
        // This proves that the server used the host before hydration.
        const expectedForm = host < 1024 ? "overlay" : "column";
        expect(
          await page
            .locator(".k2b-app-workspace")
            .evaluate((element) => getComputedStyle(element).getPropertyValue("--k2b-workspace-sidebar-form").trim()),
        ).toBe(expectedForm);
        if (host === 860) expect(await page.locator("[data-app-workspace-detail-toggle]").isVisible()).toBe(true);
      } finally {
        await page.close();
      }
    }
  });
}
