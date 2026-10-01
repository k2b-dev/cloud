import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { type Browser, chromium } from "playwright";
import { createComponent, type JSX } from "solid-js";
import { renderToString } from "solid-js/web";

// Which rule wins for a field's description and error is decided by the
// cascade, which happy-dom does not model, so a real engine renders the
// shipped stylesheet. Containers style their own subtitle by class: a bare
// `p` selector there would outrank the field part styles of fields inside.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-container-field-parts-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { TextInput } = await import("../inputs/TextInput");
const { default: AppOverview } = await import("./AppOverview");
const { default: DetailPanel } = await import("./DetailPanel");
const { default: PanelDialog } = await import("./PanelDialog");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const field = () => createComponent(TextInput, { label: "Name", description: "Shown to everyone.", error: "Name is required.", value: "" });

const containers: [string, () => JSX.Element, string][] = [
  [
    "panel dialog section body",
    () =>
      createComponent(PanelDialog.Section, {
        title: "General",
        subtitle: "Basic details.",
        get children() {
          return field();
        },
      }),
    ".k2b-panel-dialog__section-subtitle",
  ],
  [
    "app overview toolbar",
    () =>
      createComponent(AppOverview.Main, {
        title: "Your bases",
        description: "Everything you can open.",
        get toolbar() {
          return field();
        },
        children: "",
      }),
    ".k2b-app-overview__panel-description",
  ],
  [
    "detail panel section actions",
    () =>
      createComponent(DetailPanel.Section, {
        title: "Owner",
        description: "Who answers questions.",
        get actions() {
          return field();
        },
      }),
    ".k2b-detail-panel__section-description",
  ],
];

const partStyles = (selector: string) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  const style = getComputedStyle(element);
  return { color: style.color, fontSize: style.fontSize, margin: style.margin };
};

describe("field parts inside containers", () => {
  for (const [name, container, subtitle] of containers) {
    test(`${name} keeps the field's description and error styles`, async () => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body class="k2b-ui">` +
            `<div id="reference">${renderToString(field)}</div><div id="container">${renderToString(container)}</div></body></html>`,
        );
        const read = (selector: string) => page.evaluate(partStyles, selector);

        const muted = await page.evaluate(() => {
          const probe = document.createElement("span");
          probe.style.color = "var(--k2b-text-muted)";
          document.body.append(probe);
          return getComputedStyle(probe).color;
        });
        const error = await read("#container .k2b-field__error");
        expect(error).toEqual(await read("#reference .k2b-field__error"));
        expect(error.color).not.toBe(muted);
        expect(await read("#container .k2b-field__description")).toEqual(await read("#reference .k2b-field__description"));
        expect((await read(`#container ${subtitle}`)).color).toBe(muted);
      } finally {
        await page.close();
      }
    });
  }
});
