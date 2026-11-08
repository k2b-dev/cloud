import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

// The frame's head must read the same before and after the first client render. A trailing conditional anchor in the
// status line once changed WebKit's rendered text there (a subtitle lost the paragraph's blank line).
const root = mkdtempSync(resolve(tmpdir(), "k2b-dashboard-frame-parity-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { DashboardFrame } = await import("./DashboardFrame");
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "dashboard-frame-parity.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `import { createComponent, render } from "solid-js/web";
import { DashboardFrame } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.mount = (props) => {
  const app = document.getElementById("app");
  app.textContent = "";
  render(() => createComponent(DashboardFrame, { ...props, onRetry: () => {}, children: "Body" }), app);
};`,
  },
  target: "browser",
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle frame parity fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const snapshot = (page: Page) =>
  page.evaluate(() => {
    const head = document.querySelector(".k2b-dashboard-frame__header")!.getBoundingClientRect();
    return { text: document.getElementById("app")!.innerText, head: [head.x, head.y, head.width, head.height] };
  });

for (const width of [900, 390]) {
  for (const state of ["ready", "stale"] as const) {
    test(`${width}px ${state}: server and first client frame have the same rendered text and head`, async () => {
      const props = { title: "Campaigns", subtitle: "Latest 6 of 38", state, asOf: "09:12" };
      const html = renderToString(() =>
        createComponent(DashboardFrame, {
          ...props,
          onRetry: () => {},
          children: "Body",
        }),
      );
      const page = await browser.newPage({ viewport: { width, height: 600 } });
      const errors = pageErrors(page);
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui"><div id="app">${html}</div></body></html>`,
        );
        await page.addScriptTag({ content: script });
        await settled(page);
        const server = await snapshot(page);
        expect(server.text).toContain(state === "stale" ? "Refresh failed" : "Latest 6 of 38");
        await page.evaluate((props) => (window as unknown as { mount: (props: unknown) => void }).mount(props), props);
        await settled(page);
        expect(await snapshot(page)).toEqual(server);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }
}
