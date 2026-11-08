import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

const root = mkdtempSync(resolve(tmpdir(), "k2b-data-table-parity-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: DataTable } = await import("./DataTable");
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const entry = resolve(import.meta.dir, "data-table-parity.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `import { createComponent, render } from "solid-js/web";
import { DataTable } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
window.mount = (props) => {
  const app = document.getElementById("app");
  app.textContent = "";
  render(() => createComponent(DataTable, props), app);
};`,
  },
  target: "browser",
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle table parity fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const snapshot = (page: Page) =>
  page.evaluate(() => ({
    text: document.getElementById("app")!.innerText,
    rows: Array.from(document.querySelectorAll("tr"), (row) => {
      const { x, y, width, height } = row.getBoundingClientRect();
      return [x, y, width, height];
    }),
  }));

for (const width of [900, 390]) {
  for (const mode of ["rows", "empty", "details"] as const) {
    test(`${width}px ${mode}: server and first client table have the same rendered text and rows`, async () => {
      const props = {
        rows:
          mode === "empty"
            ? []
            : [
                { name: "Chair", status: "In repair" },
                { name: "Bicycle", status: "Ready" },
              ],
        columns: [
          { id: "name", header: "Item", value: "name" as const, sortable: true },
          { id: "status", header: "Status", value: "status" as const, priority: mode === "details" ? (3 as const) : undefined },
        ],
        empty: "Nothing waits.",
      };
      const html = renderToString(() => createComponent(DataTable<(typeof props.rows)[number]>, props));
      const page = await browser.newPage({ viewport: { width, height: 800 } });
      const errors = pageErrors(page);
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui"><div id="app">${html}</div></body></html>`,
        );
        await page.addScriptTag({ content: script });
        await settled(page);
        const server = await snapshot(page);
        expect(server.text).toContain(mode === "empty" ? "Nothing waits." : "Chair");
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
