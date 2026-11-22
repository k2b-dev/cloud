import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../test/browser";

// The edge contract: every field keeps a 1 px edge in every state, drawn
// inside its box, so the outer box and the text never move. States change the
// edge colour or the fill; focus and errors add a flat 3 px ring outside the
// edge, and no field casts a shadow.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const TEST_TIMEOUT = 30_000;
// Set K2B_UI_SHOTS to a directory to keep a screenshot of every state for review.
const shots = process.env.K2B_UI_SHOTS;
const entry = resolve(import.meta.dir, "control-edge.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Button, Chat, ColorInput, Combobox, DatePicker, NumberInput, Select, TagsInput, TextInput } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const options = [{ value: "one", label: "First" }, { value: "two", label: "Second" }];
// The conversation composer's pill. The assistant prompt's card takes the AI colour; chat-composer-edge.browser.test.ts
// measures it.
const composer = (variant, extra) =>
  createComponent(Chat.Composer, { variant, formatting: variant === "conversation", value: "Hello", onValueChange: () => {}, onSubmit: () => {}, ...extra });
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
    ["conversation", composer("conversation", { error })],
  ];
};
// Disabled fields, also invalid ones, sit as a muted well with a light edge. Built inside the root, as every
// component that runs effects needs.
const disabled = () => [
  ["text", createComponent(TextInput, { label: "Name", value: "Ada", disabled: true, error: "Check this value" })],
  ["number", createComponent(NumberInput, { label: "Count", value: 3, disabled: true })],
  ["select", createComponent(Select, { label: "Kind", value: "one", options, onValueChange: () => {}, disabled: true })],
  ["date", createComponent(DatePicker, { label: "Due", value: "2026-11-02", onValueChange: () => {}, disabled: true, error: "Check this value" })],
  ["color", createComponent(ColorInput, { label: "Colour", value: "#2563eb", onValueChange: () => {}, disabled: true })],
  ["conversation", composer("conversation", { disabled: true, error: "Check this value" })],
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
})()).concat(disabled().map(([name, field]) => {
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
  // A typed date field: the shared input shell with its text input.
  date: { edge: ".k2b-input-shell", focus: "input", text: "input" },
  color: { edge: ".k2b-color-input__value", focus: ".k2b-color-input__value", text: "code" },
  compact: { edge: ".k2b-input-shell", focus: "input", text: "input" },
  conversation: {
    edge: ".k2b-chat-composer__field",
    focus: "textarea:not(.k2b-chat-composer__measure)",
    text: "textarea:not(.k2b-chat-composer__measure)",
  },
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
          outline: style.outlineStyle === "none" ? 0 : Number.parseFloat(style.outlineWidth),
          background: style.backgroundColor,
        };
      }),
    ]);
    return { outer, inner, paint };
  });

// The painted edge: one 1 px border inside the box. A second source inside
// it (an inset shadow, an outline) leaves a lighter seam between the two at
// fractional zoom, and a child's fill paints over an inset but never over a
// border. The only other layer is the ring outside: spread 3 px, no offset,
// no blur, so it marks a state without depth.
const edgeOf = (paint: { borderWidth: string; borderColor: string; boxShadow: string; outline: number }) => {
  const shadows = paint.boxShadow === "none" ? [] : paint.boxShadow.split(/,(?![^(]*\))/).map((part) => part.trim());
  const rings = shadows.map((layer) => {
    const lengths = [...layer.matchAll(/(-?[\d.]+)px/g)].map((match) => Number(match[1]));
    return { layer, inset: layer.includes("inset"), lengths, color: layer.match(/(?:rgba?|color)\([^)]*\)/)?.[0] ?? "" };
  });
  return { width: Number.parseFloat(paint.borderWidth), rings, outline: paint.outline, borderColor: paint.borderColor };
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
        `${theme} ${width}px: 1 px edge in every state, ring on focus and error, same box and text position, no shadow`,
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
                edgeHover: read("var(--k2b-edge-hover)"),
                disabled: read("var(--k2b-edge-disabled)"),
                surface: read("var(--k2b-surface)"),
                muted: read("var(--k2b-surface-muted)"),
                hover: read("var(--k2b-edge-hover-bg)"),
              };
              probe.remove();
              return result;
            });
            expect(tokens.focus).not.toBe(tokens.edge);
            expect(tokens.edgeHover).not.toBe(tokens.edge);
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
                  expect(painted.width, `${label} ${state} edge width`).toBe(1);
                  expect(painted.outline, `${label} ${state} outline beside the border`).toBe(0);
                  const focused = state.startsWith("focus");
                  const expected = focused ? tokens.focus : invalid ? tokens.danger : state === "hover" ? tokens.edgeHover : tokens.edge;
                  expect(painted.borderColor, `${label} ${state} edge colour`).toBe(expected);
                  // One ring layer outside the border: no inset, no offset, no blur, 3 px spread.
                  expect(painted.rings.length, `${label} ${state} layers beside the border`).toBe(1);
                  const [ring] = painted.rings;
                  expect(ring!.inset, `${label} ${state} ring inset`).toBe(false);
                  expect(ring!.lengths, `${label} ${state} ring geometry`).toEqual([0, 0, 0, 3]);
                  const ringVisible = !/,\s*0\)$|rgba\(0, 0, 0, 0\)/.test(ring!.color);
                  expect(ringVisible, `${label} ${state} ring ${ring!.color}`).toBe(focused || invalid);
                }
                if (!invalid && name !== "input-button") {
                  // Disabled: same box and edge width, a light edge, no ring, muted fill.
                  const off = page.locator(`[data-field="${name}-disabled"]`);
                  if ((await off.count()) > 0) {
                    await page.mouse.move(5, 1090);
                    const locked = await geometry(off.locator(shells[name]!.edge).first(), off.locator(shells[name]!.text).first());
                    expect(locked.outer.width, `${label} disabled width`).toBe(seen.rest!.outer.width);
                    expect(locked.outer.height, `${label} disabled height`).toBe(seen.rest!.outer.height);
                    expect(edgeOf(locked.paint).width, `${label} disabled edge width`).toBe(1);
                    expect(locked.paint.borderColor, `${label} disabled edge`).toBe(tokens.disabled);
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

// At a fractional scale a border and an inset shadow of one colour round to
// different device pixels and leave a lighter seam between them. Scan a pixel
// column through the top edge: the edge colour must form one unbroken run.
// Steppers fill up to the inside of that border and part from the value with
// one line in the edge grey.
describe("one edge source in the browser", () => {
  for (const theme of ["light", "dark"] as const) {
    test(
      `${theme}: no seam inside the edge at 1.5x, steppers fill up to it`,
      async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 1.5 });
        try {
          await page.setContent(`<!doctype html><html lang="en"><head><style>${css}</style>
            <style>*,*::before,*::after{transition:none!important;animation:none!important}
            #app{display:flex;flex-wrap:wrap;gap:16px;padding:16px;align-items:flex-start}</style></head>
            <body class="k2b-ui" data-theme="${theme}" style="margin:0"><div id="app"></div></body></html>`);
          await page.addScriptTag({ content: script });
          await page.locator('[data-field="input-button"] .k2b-button').waitFor();

          // Distance of each pixel from the surface, down the column at the middle of the edge.
          const column = async (edge: Locator) => {
            const box = (await edge.boundingBox())!;
            const clip = { x: box.x + box.width / 2, y: box.y - 3, width: 1, height: 10 };
            const png = (await page.screenshot({ clip })).toString("base64");
            return page.evaluate(async (data) => {
              const image = new Image();
              image.src = `data:image/png;base64,${data}`;
              await image.decode();
              const canvas = document.createElement("canvas");
              canvas.width = image.width;
              canvas.height = image.height;
              const context = canvas.getContext("2d")!;
              context.drawImage(image, 0, 0);
              const pixels = context.getImageData(0, 0, 1, image.height).data;
              const values: number[][] = [];
              for (let index = 0; index < pixels.length; index += 4) values.push([pixels[index]!, pixels[index + 1]!, pixels[index + 2]!]);
              const [base] = values;
              return values.map((pixel) => pixel.reduce((sum, channel, at) => sum + Math.abs(channel - base![at]!), 0));
            }, png);
          };
          const seam = (distances: number[]) => {
            const strongest = Math.max(...distances);
            const strong = distances.map((distance) => distance >= strongest * 0.8);
            // The column has to cross a visible edge; a 1 px edge is one or two device pixels deep at 1.5x.
            if (strongest < 40) return true;
            const first = strong.indexOf(true);
            const last = strong.lastIndexOf(true);
            return strong.slice(first, last + 1).includes(false);
          };

          for (const invalid of [false, true]) {
            for (const name of Object.keys(shells)) {
              if (invalid && name === "input-button") continue;
              const cell = page.locator(`[data-field="${name}${invalid ? "-invalid" : ""}"]`);
              const edge = cell.locator(shells[name]!.edge).first();
              for (const state of ["rest", "focus"] as const) {
                await enter(page, cell, name, state);
                const distances = await column(edge);
                expect(seam(distances), `${theme} ${name}${invalid ? " invalid" : ""} ${state} edge pixels ${distances.join(" ")}`).toBe(
                  false,
                );
              }
            }
          }

          const number = page.locator('[data-field="number"]');
          const shell = number.locator(".k2b-input-shell");
          const step = number.locator(".k2b-number-input__step").first();
          for (const state of ["rest", "hover", "focus", "focus-hover"] as const) {
            await page.mouse.move(5, 1090);
            await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
            if (state.startsWith("focus")) await number.locator("input").focus();
            if (state.endsWith("hover")) await hoverInPlace(step);
            await settled(page);
            const [outer, inner, line] = await Promise.all([
              shell.evaluate((node) => {
                const style = getComputedStyle(node);
                const { x, y, height } = node.getBoundingClientRect();
                return { x, y, height, border: Number.parseFloat(style.borderTopWidth), overflow: style.overflow };
              }),
              step.evaluate((node) => {
                const { x, y, height } = node.getBoundingClientRect();
                return { x, y, height, shadow: getComputedStyle(node).boxShadow };
              }),
              step.evaluate((node) => {
                const probe = document.createElement("span");
                probe.style.color = "var(--k2b-edge)";
                node.append(probe);
                const edge = getComputedStyle(probe).color;
                probe.remove();
                return { color: getComputedStyle(node).borderRightColor, width: getComputedStyle(node).borderRightWidth, edge };
              }),
            ]);
            const label = `${theme} stepper ${state}`;
            // The fill starts right inside the border and is clipped to its rounded corner. WebKit lays out in 1/64 px,
            // so a 1 px border at 1.5x lands within that unit.
            expect(inner.x, `${label} left`).toBeCloseTo(outer.x + outer.border, 1);
            expect(inner.y, `${label} top`).toBeCloseTo(outer.y + outer.border, 1);
            expect(inner.height, `${label} height`).toBeCloseTo(outer.height - 2 * outer.border, 1);
            expect(outer.overflow, `${label} clip`).toBe("hidden");
            expect(inner.shadow, `${label} own edge`).toBe("none");
            // 1 px; WebKit snaps it to one device pixel at 1.5x (0.667 px).
            const divider = Number.parseFloat(line.width);
            expect(divider > 0 && divider <= 1, `${label} divider width ${line.width}`).toBe(true);
            expect(line.color, `${label} divider colour`).toBe(line.edge);
          }
          // Forced colours drop the fill, so a stepper focused from the keyboard shows the system outline.
          await page.emulateMedia({ forcedColors: "active" });
          await step.evaluate((node: HTMLElement) => node.focus({ focusVisible: true } as FocusOptions));
          await settled(page);
          expect(await step.evaluate((node) => getComputedStyle(node).outlineStyle), `${theme} forced stepper focus`).toBe("solid");
          await page.emulateMedia({ forcedColors: "none" });
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT * 2,
    );
  }
});

// Filters share the field edge as a pure 1 px inset (no border); an active
// filter takes the selected edge and fill, and focus adds the ring outside.
// Selected tabs and views show the fill only. Secondary buttons keep the 1 px
// field edge, one step darker on hover; clickable cards keep a light 1 px
// border in every state and change only their fill. The card sits
// in a flat layer here: in the main content a clickable card is an island with
// the island shadow (elevation.browser.test.ts), which no state changes.
const controlsEntry = resolve(import.meta.dir, "control-edge-controls.fixture.ts");
const controlsFixture = `
import { createComponent, render } from "solid-js/web";
import { Button, FilterChip, FilterToggle, Paper, SegmentedControl, Tabs, ViewTabs } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const cell = (name, make) => {
  const node = document.createElement("div");
  node.dataset.control = name;
  node.dataset.k2bLayer = "flat";
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
  cell("segment", () => createComponent(SegmentedControl, { value: "list", onValueChange: () => {}, ariaLabel: "View", options: [{ value: "list", label: "List" }, { value: "board", label: "Board" }] })),
  cell("tabs", () => createComponent(Tabs, { value: "a", onValueChange: () => {}, ariaLabel: "Panels", options: [{ value: "a", label: "Details" }, { value: "b", label: "History" }] })),
  cell("views", () => createComponent(ViewTabs, { label: "Views", current: "all", items: [{ id: "all", label: "All", href: "#all" }, { id: "mine", label: "Mine", href: "#mine" }] })),
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
      `${theme}: fixed geometry, 1 px edges, ring only on focus, no shadow`,
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
              edgeHover: read("var(--k2b-edge-hover)"),
              selected: mix("--k2b-edge-selected-share"),
              selectedFill: mix("--k2b-edge-selected-fill"),
              selectedHover: mix("--k2b-edge-selected-hover-fill"),
              cardBorder: read("var(--k2b-border-strong)"),
              tray: read("var(--k2b-tray)"),
              trayHover: read("var(--k2b-tray-hover)"),
              tabHover: read("var(--k2b-app-workspace-hover)"),
              none: read("transparent"),
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
              // The focus ring: an outer layer without offset or blur. Transparent at rest.
              const outer = shadows.filter((part) => !part.includes("inset"));
              const ringColor = outer[0]?.match(/(?:rgba?|color)\([^)]*\)/)?.[0];
              return {
                box: { x: x + scrollX, y: y + scrollY, width, height },
                border: Number.parseFloat(style.borderTopWidth),
                borderColor: rgba(style.borderTopColor),
                inset: Number(inset[0]?.match(/(-?[\d.]+)px\s+inset/)?.[1] ?? 0),
                insetColor: color ? rgba(color) : undefined,
                // Any outer layer with an offset or a blur is depth; a ring (spread only) is a state mark.
                drop: outer.filter((part) => {
                  const [x = 0, y = 0, blur = 0] = [...part.matchAll(/(-?[\d.]+)px/g)].map((match) => Number(match[1]));
                  return x !== 0 || y !== 0 || blur !== 0;
                }),
                ring: ringColor && ringColor !== "rgba(0, 0, 0, 0)" ? rgba(ringColor) : undefined,
                outline: style.outlineStyle === "none" ? "none" : `${style.outlineStyle} ${style.outlineWidth}`,
                background: rgba(style.backgroundColor),
              };
            });

          // `ring`: focus shows the soft ring; `outline`: focus on a chosen control shows the shared ring with a gap.
          type Expect = {
            border: number;
            ring: boolean;
            outline?: boolean;
            edge: (state: string) => string;
            fill: (state: string) => string;
          };
          const filter = (rest: string, fill: string, hover: string, hoverEdge = rest): Expect => ({
            border: 0,
            ring: true,
            edge: (state) => (state === "focus" ? tokens.focus : state === "hover" ? hoverEdge : rest),
            fill: (state) => (state === "hover" ? hover : fill),
          });
          const bordered = (color: string, hoverEdge = color): Expect => ({
            border: 1,
            ring: false,
            edge: (state) => (state === "hover" ? hoverEdge : color),
            fill: (state) => (state === "hover" ? tokens.hover : tokens.surface),
          });
          // Group members (segment options, tabs, views) have no edge until selected; tabs and views not even then.
          const member = (hover: string) => filter(tokens.none, tokens.none, hover);
          // Tabs and views sit in a clipping strip: their soft focus band lies inside, so no outer ring.
          const strip = (expected: Expect): Expect => ({ ...expected, ring: false });
          const selected: Expect = { ...filter(tokens.selected, tokens.selectedFill, tokens.selectedHover), ring: false, outline: true };
          const controls: Record<string, [string, Expect, string?]> = {
            chip: [".k2b-filter-chip", filter(tokens.edge, tokens.surface, tokens.hover, tokens.edgeHover)],
            "chip-active": [".k2b-filter-chip", selected],
            "toggle-active": [".k2b-filter-chip", selected],
            secondary: [".k2b-button", bordered(tokens.edge, tokens.edgeHover)],
            subtle: [".k2b-button", bordered(tokens.edge, tokens.edgeHover)],
            card: [".k2b-paper", bordered(tokens.cardBorder)],
            segment: ['.k2b-segmented-control__option:not([aria-checked="true"])', member(tokens.trayHover)],
            "segment-selected": ['.k2b-segmented-control__option[aria-checked="true"]', selected, "segment"],
            // K2, K6: line tabs and views have no fill in any state; hover darkens the text, the selected one carries
            // a 2 px mark on the line (selection-contract and status-row tests).
            tab: ['[role="tab"]:not([aria-selected="true"])', strip(member(tokens.none)), "tabs"],
            "tab-selected": ['[role="tab"][aria-selected="true"]', strip(member(tokens.none)), "tabs"],
            view: ['.k2b-view-tabs__tab:not([aria-current="page"])', strip(member(tokens.none)), "views"],
            "view-selected": ['.k2b-view-tabs__tab[aria-current="page"]', strip(member(tokens.none)), "views"],
          };

          // Segment options sit on the grey track.
          const track = await measure(page.locator('[data-control="segment"] .k2b-segmented-control'));
          expect(track.background, `${theme} segment track`).toBe(tokens.tray);
          expect(track.drop, `${theme} segment track shadow`).toEqual([]);

          for (const [name, [selector, expected, cell]] of Object.entries(controls)) {
            const element = page.locator(`[data-control="${cell ?? name}"] ${selector}`).first();
            const seen: Record<string, Awaited<ReturnType<typeof measure>>> = {};
            for (const state of ["rest", "hover", "focus"] as const) {
              await page.mouse.move(5, 890);
              await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
              if (state === "focus") await element.evaluate((node: HTMLElement) => node.focus({ focusVisible: true } as FocusOptions));
              if (state === "hover") await hoverInPlace(element);
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
              if (expected.ring) expect(actual.ring !== undefined, `${label} focus ring`).toBe(state === "focus");
              if (expected.outline) {
                expect(actual.ring, `${label} no soft ring`).toBeUndefined();
                expect(actual.outline, `${label} focus outline`).toBe(state === "focus" ? "solid 2px" : "none");
              }
              if (expected.border === 0) {
                expect(actual.inset, `${label} edge width`).toBe(1);
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
