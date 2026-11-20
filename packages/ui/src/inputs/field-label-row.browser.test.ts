import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Two fields side by side, one with label actions (a suggestion's status and Accept) and one without, must keep
// their controls level. Only a real layout engine shows a label row that grows with its actions, so the shipped
// browser build renders real fields here.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Lives only in memory; its path makes bare imports resolve from this package.
const entry = resolve(import.meta.dir, "field-label-row.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { LocaleProvider, NumberInput, Select, SuggestionGroup, TextInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const states = {
  none: undefined,
  loading: { id: "estimate", state: "loading" },
  open: { id: "estimate:1", state: "ready", value: 90, confidence: "high" },
  unsure: { id: "estimate:1", state: "ready", value: 240, confidence: "low", reason: "The task does not say how many rooms." },
  accepted: { id: "estimate:1", state: "ready", value: 90, confidence: "high", accepted: true },
  own: { id: "estimate:1", state: "ready", value: 60, confidence: "high" },
  error: { id: "estimate", state: "error", onRetry: () => {} },
};
const [state, setState] = createSignal("none");
const [value, setValue] = createSignal(null);
globalThis.show = (next) => {
  setValue(next === "accepted" ? 90 : next === "own" ? 30 : null);
  setState(next);
};
const suggestion = () => ({ ...states[state()], source: "Gustav" });
render(
  () =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(SuggestionGroup, {
          source: "Gustav",
          onAcceptAll: () => {},
          get children() {
            return [
              createComponent(TextInput, { label: "Fälligkeitsdatum", value: "6. Okt. 2026, 17:00" }),
              createComponent(NumberInput, {
                label: "Geschätzte Dauer",
                step: 15,
                min: 15,
                suffix: "min",
                value,
                onValueChange: setValue,
                suggestion: () => (state() === "none" ? undefined : suggestion()),
              }),
              createComponent(Select, {
                label: "Priorität",
                value: null,
                options: [{ value: "high", label: "Hoch" }],
                suggestion: () => (state() === "none" ? undefined : { id: "priority", state: "ready", value: "high", confidence: "high" }),
              }),
              createComponent(TextInput, { label: "Ort", value: "" }),
            ];
          },
        });
      },
    }),
  document.getElementById("row"),
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the label row fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const load = async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head>` +
      `<body class="k2b-ui" style="margin:0;padding:16px"><div id="row" style="width:760px"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.locator("input").first().waitFor();
  // The group lays its fields out two by two, as a form row does.
  await page.addStyleTag({
    content:
      ".k2b-ai-suggestion-group { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem }" +
      ".k2b-ai-suggestion-group > .k2b-ai-suggestion-group__bar, .k2b-ai-suggestion-group > .k2b-sr-only { grid-column: 1 / -1 }",
  });
  return page;
};

/** Top and bottom of each field's control, the part after its label row: an input shell or a choice trigger. */
const controls = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".k2b-field, .k2b-ai-suggestion-field"), (field) => {
      const control = field.querySelector(
        ":scope > :not(.k2b-field__label, .k2b-field__label-row, .k2b-field__description, .k2b-field__error, .k2b-sr-only)",
      )!;
      const box = control.getBoundingClientRect();
      return { label: field.querySelector(".k2b-field__label")?.textContent?.trim(), top: box.top, bottom: box.bottom };
    }),
  );

describe("a field's label row", () => {
  test("label actions never push a field's control below its neighbour's, in any suggestion state", async () => {
    const page = await load();
    try {
      for (const view of ["none", "loading", "open", "unsure", "accepted", "own", "error"]) {
        await page.evaluate((next) => (globalThis as unknown as { show: (state: string) => void }).show(next), view);
        await settled(page);
        await page.locator("#row").screenshot({ path: `/tmp/field-label-row-${view}.png`, animations: "disabled" });
        const [due, estimate, priority, place] = await controls(page);
        for (const [left, right] of [
          [due!, estimate!],
          [priority!, place!],
        ] as const) {
          expect({ view, field: right.label, top: Math.abs(right.top - left.top) <= 0.5 }).toEqual({ view, field: right.label, top: true });
          expect({ view, field: right.label, bottom: Math.abs(right.bottom - left.bottom) <= 0.5 }).toEqual({
            view,
            field: right.label,
            bottom: true,
          });
        }
      }
    } finally {
      await page.close();
    }
  }, 60_000);
});
