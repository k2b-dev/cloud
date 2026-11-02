import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// The edge contract: every field keeps a 2 px edge in every state, drawn
// inside its box, so the outer box and the text never move. States change the
// edge colour or the fill only, and no field casts a shadow.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const TEST_TIMEOUT = 30_000;
// Set K2B_UI_SHOTS to a directory to keep a screenshot of every state for review.
const shots = process.env.K2B_UI_SHOTS;
const entry = resolve(import.meta.dir, "control-edge.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Button, ColorInput, Combobox, DatePicker, NumberInput, Select, TagsInput, TextInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const options = [{ value: "one", label: "First" }, { value: "two", label: "Second" }];
const fields = (invalid) => {
  const error = invalid ? "Check this value" : undefined;
  return [
    ["text", createComponent(TextInput, { label: "Name", value: "Ada", error })],
    ["search", createComponent(TextInput, { label: "Search", icon: "ti ti-search", value: "notes", error })],
    ["multiline", createComponent(TextInput, { label: "Note", multiline: true, value: "Line", error })],
    ["number", createComponent(NumberInput, { label: "Count", value: 3, error })],
    ["select", createComponent(Select, { label: "Kind", value: "one", options, onValueChange: () => {}, error })],
    ["combobox", createComponent(Combobox, { label: "Owner", value: "one", options, onValueChange: () => {}, error })],
    ["tags", createComponent(TagsInput, { label: "Tags", value: ["red"], onValueChange: () => {}, error })],
    ["date", createComponent(DatePicker, { label: "Due", value: "2026-11-02", onValueChange: () => {}, error })],
    ["color", createComponent(ColorInput, { label: "Colour", value: "#2563eb", onValueChange: () => {}, error })],
    ["compact", createComponent(TextInput, { "aria-label": "Width", variant: "compact", value: "120", error })],
  ];
};
// Disabled fields, also invalid ones, drop the edge and sit as a muted well.
const disabled = [
  ["text", createComponent(TextInput, { label: "Name", value: "Ada", disabled: true, error: "Check this value" })],
  ["number", createComponent(NumberInput, { label: "Count", value: 3, disabled: true })],
  ["select", createComponent(Select, { label: "Kind", value: "one", options, onValueChange: () => {}, disabled: true })],
  ["date", createComponent(DatePicker, { label: "Due", value: "2026-11-02", onValueChange: () => {}, disabled: true, error: "Check this value" })],
  ["color", createComponent(ColorInput, { label: "Colour", value: "#2563eb", onValueChange: () => {}, disabled: true })],
];
render(() => [false, true].map((invalid) =>
  fields(invalid).map(([name, field]) => {
    const cell = document.createElement("div");
    cell.dataset.field = name + (invalid ? "-invalid" : "");
    cell.style.cssText = "width:260px";
    render(() => field, cell);
    return cell;
  })
).flat().concat((() => {
  const cell = document.createElement("div");
  cell.dataset.field = "input-button";
  cell.style.cssText = "width:260px";
  render(() => createComponent(Button, { variant: "input", children: "Choose a file" }), cell);
  return [cell];
})()).concat(disabled.map(([name, field]) => {
  const cell = document.createElement("div");
  cell.dataset.field = name + "-disabled";
  cell.style.cssText = "width:260px";
  render(() => field, cell);
  return cell;
})), document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the control edge fixture.");
const script = await build.outputs[0]!.text();

// The element that draws the edge and the element whose text must not move.
const shells: Record<string, { edge: string; focus: string; text: string }> = {
  text: { edge: ".k2b-input-shell", focus: "input", text: "input" },
  search: { edge: ".k2b-input-shell", focus: "input", text: "input" },
  multiline: { edge: ".k2b-input-shell", focus: "textarea", text: "textarea" },
  number: { edge: ".k2b-input-shell", focus: "input", text: "input" },
  select: { edge: ".k2b-choice-trigger", focus: ".k2b-choice-trigger", text: ".k2b-choice-trigger__value" },
  combobox: { edge: ".k2b-combobox__input", focus: "input", text: "input" },
  tags: { edge: ".k2b-tags-input", focus: "input", text: ".k2b-tags-input__icon" },
  date: { edge: ".k2b-date-trigger", focus: ".k2b-date-trigger", text: ".k2b-date-trigger__value" },
  color: { edge: ".k2b-color-input__value", focus: ".k2b-color-input__value", text: "code" },
  compact: { edge: ".k2b-input-shell", focus: "input", text: "input" },
  "input-button": { edge: ".k2b-button", focus: ".k2b-button", text: ".k2b-button__label" },
};

const geometry = (element: Locator, text: Locator) =>
  Promise.all([element, text]).then(async ([edge, label]) => {
    const [outer, inner, paint] = await Promise.all([
      // Document coordinates: hovering may scroll a narrow page.
      edge.evaluate((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        return { x: x + scrollX, y: y + scrollY, width, height };
      }),
      label.evaluate((node) => {
        const { x, y } = node.getBoundingClientRect();
        return { x: x + scrollX, y: y + scrollY };
      }),
      edge.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          borderWidth: style.borderTopWidth,
          borderColor: style.borderTopColor,
          boxShadow: style.boxShadow,
          background: style.backgroundColor,
        };
      }),
    ]);
    return { outer, inner, paint };
  });

// The painted edge: 1 px border plus an inset shadow of the same colour. A
// border-less control (the compact field) carries the full width as inset.
const edgeOf = (paint: { borderWidth: string; borderColor: string; boxShadow: string }) => {
  const shadows = paint.boxShadow === "none" ? [] : paint.boxShadow.split(/,(?![^(]*\))/).map((part) => part.trim());
  const inset = shadows.filter((part) => part.includes("inset"));
  const drop = shadows.filter((part) => !part.includes("inset"));
  const spread = inset.map((part) => Number(part.match(/(-?[\d.]+)px\s+inset/)?.[1] ?? Number.NaN));
  const color = inset[0]?.match(/rgba?\([^)]*\)/)?.[0];
  return { width: Number.parseFloat(paint.borderWidth) + (spread[0] ?? 0), color, drop, borderColor: paint.borderColor };
};

const states = ["rest", "hover", "focus", "focus-hover"] as const;

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (theme: "light" | "dark", width: number): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 1100 } });
  await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style>
    <style>*,*::before,*::after{transition:none!important;animation:none!important}
    #app{display:flex;flex-wrap:wrap;gap:16px;padding:16px;align-items:flex-start}</style></head>
    <body class="k2b-ui" data-theme="${theme}" style="margin:0"><div id="app"></div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.locator('[data-field="input-button"] .k2b-button').waitFor();
  await page.mouse.move(5, 1090);
  await settled(page);
  return page;
};

const enter = async (page: Page, cell: Locator, name: string, state: (typeof states)[number]) => {
  const shell = shells[name]!;
  await page.mouse.move(5, 1090);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  if (state === "focus" || state === "focus-hover") {
    // Keyboard focus, as Tab gives it: `:focus-visible` on triggers.
    const target = cell.locator(shell.focus).first();
    await target.evaluate((node: HTMLElement) => node.focus({ focusVisible: true } as FocusOptions));
  }
  if (state === "hover" || state === "focus-hover") await cell.locator(shell.edge).first().hover();
  await settled(page);
};

describe("field edge contract in the browser", () => {
  for (const theme of ["light", "dark"] as const) {
    for (const width of [1280, 390]) {
      test(
        `${theme} ${width}px: 2 px edge in every state, same box and text position, no shadow`,
        async () => {
          const page = await open(theme, width);
          try {
            const tokens = await page.evaluate(() => {
              const probe = document.createElement("span");
              document.body.append(probe);
              const read = (value: string) => {
                probe.style.color = value;
                return getComputedStyle(probe).color;
              };
              const result = {
                edge: read("var(--k2b-edge)"),
                focus: read("var(--k2b-edge-focus)"),
                danger: read("var(--k2b-edge-danger)"),
                surface: read("var(--k2b-surface)"),
                muted: read("var(--k2b-surface-muted)"),
                hover: read("var(--k2b-edge-hover-bg)"),
              };
              probe.remove();
              return result;
            });
            expect(tokens.focus).not.toBe(tokens.edge);
            expect(tokens.hover).not.toBe(tokens.surface);

            for (const invalid of [false, true]) {
              for (const name of Object.keys(shells)) {
                if (invalid && name === "input-button") continue;
                const cell = page.locator(`[data-field="${name}${invalid ? "-invalid" : ""}"]`);
                const edge = cell.locator(shells[name]!.edge).first();
                const text = cell.locator(shells[name]!.text).first();
                const seen: Record<string, Awaited<ReturnType<typeof geometry>>> = {};
                for (const state of states) {
                  await enter(page, cell, name, state);
                  seen[state] = await geometry(edge, text);
                  if (shots && width === 1280) {
                    mkdirSync(shots, { recursive: true });
                    await cell.screenshot({ path: resolve(shots, `${theme}-${name}${invalid ? "-invalid" : ""}-${state}.png`) });
                  }
                }
                const label = `${theme} ${width} ${name}${invalid ? " invalid" : ""}`;
                for (const state of states) {
                  const { outer, inner, paint } = seen[state]!;
                  const painted = edgeOf(paint);
                  expect(outer, `${label} ${state} box`).toEqual(seen.rest!.outer);
                  expect(inner, `${label} ${state} text`).toEqual(seen.rest!.inner);
                  expect(painted.width, `${label} ${state} edge width`).toBe(2);
                  expect(painted.drop, `${label} ${state} drop shadow`).toEqual([]);
                  expect(painted.color, `${label} ${state} inset = border colour`).toBe(painted.borderColor);
                  const expected = state.startsWith("focus") ? tokens.focus : invalid ? tokens.danger : tokens.edge;
                  expect(painted.borderColor, `${label} ${state} edge colour`).toBe(expected);
                }
                if (!invalid && name !== "input-button") {
                  // Disabled: same box and edge width, no visible edge, muted fill.
                  const off = page.locator(`[data-field="${name}-disabled"]`);
                  if ((await off.count()) > 0) {
                    await page.mouse.move(5, 1090);
                    const locked = await geometry(off.locator(shells[name]!.edge).first(), off.locator(shells[name]!.text).first());
                    expect(locked.outer.width, `${label} disabled width`).toBe(seen.rest!.outer.width);
                    expect(locked.outer.height, `${label} disabled height`).toBe(seen.rest!.outer.height);
                    expect(edgeOf(locked.paint).width, `${label} disabled edge width`).toBe(2);
                    expect(locked.paint.borderColor, `${label} disabled edge`).toBe("rgba(0, 0, 0, 0)");
                    expect(locked.paint.background, `${label} disabled fill`).toBe(tokens.muted);
                  }
                }
                expect(seen.rest!.paint.background, `${label} rest fill`).toBe(tokens.surface);
                expect(seen.hover!.paint.background, `${label} hover fill`).toBe(tokens.hover);
                expect(seen.focus!.paint.background, `${label} focus fill`).toBe(tokens.surface);
              }
            }
          } finally {
            await page.close();
          }
        },
        TEST_TIMEOUT * 3,
      );
    }
  }
});

// Filters share the field edge as a pure inset (no border); an active filter
// takes the selected edge and fill. Secondary buttons and clickable cards keep
// a light 1 px border in every state and change only their fill.
const controlsEntry = resolve(import.meta.dir, "control-edge-controls.fixture.ts");
const controlsFixture = `
import { createComponent, render } from "solid-js/web";
import { Button, FilterChip, FilterToggle, Paper } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const cell = (name, make) => {
  const node = document.createElement("div");
  node.dataset.control = name;
  node.style.cssText = "width:260px";
  render(make, node);
  return node;
};
const options = [{ options: [{ value: "mine", label: "Mine" }] }];
document.getElementById("app").append(
  cell("chip", () => createComponent(FilterChip, { label: "Owner", icon: "ti ti-user", value: [], onValueChange: () => {}, options })),
  cell("chip-active", () => createComponent(FilterChip, { label: "Owner", icon: "ti ti-user", value: ["mine"], onValueChange: () => {}, options })),
  cell("toggle-active", () => createComponent(FilterToggle, { label: "Only mine", icon: "ti ti-user", active: true, onClick: () => {} })),
  cell("secondary", () => createComponent(Button, { variant: "secondary", children: "Export" })),
  cell("subtle", () => createComponent(Button, { variant: "subtle", children: "More" })),
  cell("card", () => createComponent(Paper, { interactive: true, tabIndex: 0, style: { padding: "12px" }, children: "Open the project" })),
);
`;
const controlsBuild = await Bun.build({
  entrypoints: [controlsEntry],
  files: { [controlsEntry]: controlsFixture },
  target: "browser",
  format: "iife",
});
if (!controlsBuild.success) throw new AggregateError(controlsBuild.logs, "Could not bundle the control edge controls fixture.");
const controlsScript = await controlsBuild.outputs[0]!.text();

describe("filters, secondary buttons, and clickable cards in the browser", () => {
  for (const theme of ["light", "dark"] as const) {
    test(
      `${theme}: fixed geometry, no shadow, border never darkens`,
      async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        try {
          await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style>
            <style>*,*::before,*::after{transition:none!important;animation:none!important}
            #app{display:flex;flex-wrap:wrap;gap:16px;padding:16px;align-items:flex-start}</style></head>
            <body class="k2b-ui" data-theme="${theme}" style="margin:0"><div id="app"></div></body></html>`);
          await page.addScriptTag({ content: controlsScript });
          await page.locator('[data-control="card"] .k2b-paper').waitFor();
          // color-mix() serializes as color(srgb …); a canvas turns every colour into rgba().
          const tokens = await page.evaluate(() => {
            const context = document.createElement("canvas").getContext("2d")!;
            const probe = document.createElement("span");
            document.body.append(probe);
            const read = (value: string) => {
              probe.style.color = value;
              context.clearRect(0, 0, 1, 1);
              context.fillStyle = getComputedStyle(probe).color;
              context.fillRect(0, 0, 1, 1);
              const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
              return `rgba(${r}, ${g}, ${b}, ${a! / 255})`;
            };
            const mix = (share: string) => read(`color-mix(in srgb, var(--k2b-app-workspace-active) var(${share}), var(--k2b-surface))`);
            const result = {
              edge: read("var(--k2b-edge)"),
              focus: read("var(--k2b-edge-focus)"),
              surface: read("var(--k2b-surface)"),
              hover: read("var(--k2b-edge-hover-bg)"),
              selected: mix("--k2b-edge-selected-share"),
              selectedFill: mix("--k2b-edge-selected-fill"),
              selectedHover: mix("--k2b-edge-selected-hover-fill"),
              soft: read("var(--k2b-control-border-soft)"),
              cardBorder: read("var(--k2b-border-strong)"),
            };
            probe.remove();
            return result;
          });

          const measure = (element: Locator) =>
            element.evaluate((node) => {
              const context = document.createElement("canvas").getContext("2d")!;
              const rgba = (color: string) => {
                context.clearRect(0, 0, 1, 1);
                context.fillStyle = color;
                context.fillRect(0, 0, 1, 1);
                const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
                return `rgba(${r}, ${g}, ${b}, ${a! / 255})`;
              };
              const style = getComputedStyle(node);
              const { x, y, width, height } = node.getBoundingClientRect();
              const shadows = style.boxShadow === "none" ? [] : style.boxShadow.split(/,(?![^(]*\))/).map((part) => part.trim());
              const inset = shadows.filter((part) => part.includes("inset"));
              const color = inset[0]?.match(/(?:rgba?|color)\([^)]*\)/)?.[0];
              return {
                box: { x: x + scrollX, y: y + scrollY, width, height },
                border: Number.parseFloat(style.borderTopWidth),
                borderColor: rgba(style.borderTopColor),
                inset: Number(inset[0]?.match(/(-?[\d.]+)px\s+inset/)?.[1] ?? 0),
                insetColor: color ? rgba(color) : undefined,
                drop: shadows.filter((part) => !part.includes("inset")),
                background: rgba(style.backgroundColor),
              };
            });

          type Expect = { border: number; edge: (state: string) => string; fill: (state: string) => string };
          const filter = (rest: string, fill: string, hover: string): Expect => ({
            border: 0,
            edge: (state) => (state === "focus" ? tokens.focus : rest),
            fill: (state) => (state === "hover" ? hover : fill),
          });
          const bordered = (color: string): Expect => ({
            border: 1,
            edge: () => color,
            fill: (state) => (state === "hover" ? tokens.hover : tokens.surface),
          });
          const controls: Record<string, [string, Expect]> = {
            chip: [".k2b-filter-chip", filter(tokens.edge, tokens.surface, tokens.hover)],
            "chip-active": [".k2b-filter-chip", filter(tokens.selected, tokens.selectedFill, tokens.selectedHover)],
            "toggle-active": [".k2b-filter-chip", filter(tokens.selected, tokens.selectedFill, tokens.selectedHover)],
            secondary: [".k2b-button", bordered(tokens.soft)],
            subtle: [".k2b-button", bordered(tokens.soft)],
            card: [".k2b-paper", bordered(tokens.cardBorder)],
          };

          for (const [name, [selector, expected]] of Object.entries(controls)) {
            const element = page.locator(`[data-control="${name}"] ${selector}`).first();
            const seen: Record<string, Awaited<ReturnType<typeof measure>>> = {};
            for (const state of ["rest", "hover", "focus"] as const) {
              await page.mouse.move(5, 890);
              await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
              if (state === "focus") await element.evaluate((node: HTMLElement) => node.focus({ focusVisible: true } as FocusOptions));
              if (state === "hover") await element.hover();
              await settled(page);
              seen[state] = await measure(element);
              if (shots) {
                mkdirSync(shots, { recursive: true });
                await element.screenshot({ path: resolve(shots, `${theme}-control-${name}-${state}.png`) });
              }
            }
            for (const state of ["rest", "hover", "focus"] as const) {
              const actual = seen[state]!;
              const label = `${theme} ${name} ${state}`;
              expect(actual.box, `${label} box`).toEqual(seen.rest!.box);
              expect(actual.drop, `${label} drop shadow`).toEqual([]);
              expect(actual.border, `${label} border width`).toBe(expected.border);
              expect(actual.background, `${label} fill`).toBe(expected.fill(state));
              if (expected.border === 0) {
                expect(actual.inset, `${label} edge width`).toBe(2);
                expect(actual.insetColor, `${label} edge colour`).toBe(expected.edge(state));
              } else {
                expect(actual.inset, `${label} inset`).toBe(0);
                expect(actual.borderColor, `${label} border colour`).toBe(expected.edge(state));
              }
            }
          }
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );
  }
});
