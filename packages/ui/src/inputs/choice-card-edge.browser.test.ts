import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Choice cards follow the edge contract: a 2 px edge inside the card in every
// state, so the card and its text never move. Rest is grey, hover darkens the
// fill only, focus turns the edge strong blue, a chosen card takes a light blue
// edge and fill, and focus on a chosen card is strong blue again. No shadow.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const TEST_TIMEOUT = 30_000;
const entry = resolve(import.meta.dir, "choice-card-edge.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { CheckboxCard, ChoiceList } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
render(() => {
  const [billing, setBilling] = createSignal("fixed");
  const [repeat, setRepeat] = createSignal("once");
  const [notify, setNotify] = createSignal(true);
  const [archive, setArchive] = createSignal(false);
  return [
    createComponent(ChoiceList, { label: "Billing", value: billing, onValueChange: setBilling, options: [
      { value: "fixed", label: "Fixed price", description: "The customer pays the agreed amount." },
      { value: "time", label: "Time and material", description: "Hours and material go on the invoice." },
    ] }),
    createComponent(ChoiceList, { "aria-label": "Repeat", value: repeat, onValueChange: setRepeat, options: [
      { value: "once", label: "Once" }, { value: "monthly", label: "Monthly" }, { value: "yearly", label: "Yearly" },
    ] }),
    createComponent(ChoiceList, { "aria-label": "Locked", value: "a", disabled: true, options: [{ value: "a", label: "Locked A" }, { value: "b", label: "Locked B" }] }),
    createComponent(CheckboxCard, { label: "Notify by email", value: notify, onValueChange: setNotify }),
    createComponent(CheckboxCard, { label: "Archive afterwards", value: archive, onValueChange: setArchive }),
    createComponent(CheckboxCard, { label: "Field look", variant: "input", value: false }),
    createComponent(CheckboxCard, { label: "Accept terms", value: false, error: "Accept to continue" }),
    createComponent(CheckboxCard, { label: "Locked card", value: true, disabled: true }),
  ];
}, document.getElementById("app"));
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the choice card fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const probes = {
  edge: "var(--k2b-edge)",
  focus: "var(--k2b-edge-focus)",
  selected: "color-mix(in srgb, var(--k2b-action) var(--k2b-edge-selected-share), var(--k2b-surface))",
  surface: "var(--k2b-surface)",
  hover: "var(--k2b-edge-hover-bg)",
  selectedFill: "color-mix(in srgb, var(--k2b-action) var(--k2b-edge-selected-fill), var(--k2b-surface))",
  selectedHover: "color-mix(in srgb, var(--k2b-action) var(--k2b-edge-selected-hover-fill), var(--k2b-surface))",
  danger: "var(--k2b-edge-danger)",
  muted: "var(--k2b-surface-muted)",
};

const load = async (theme: "light" | "dark", width = 900) => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const probeHtml = Object.entries(probes)
    .map(([name, value]) => `<i data-probe="${name}" style="background:${value}"></i>`)
    .join("");
  await page.setContent(`<!doctype html><html><head><style>${css}</style>
    <style>*,*::before,*::after{transition:none!important}#app{display:grid;gap:16px;padding:16px;width:min(640px,100%);box-sizing:border-box}</style></head>
    <body class="k2b-ui" data-theme="${theme}" style="margin:0"><div id="app"></div><div hidden>${probeHtml}</div></body></html>`);
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-checkbox-card").last().waitFor();
  await settled(page);
  return page;
};

/** Paint of one card: edge colour and width, fill, outer shadow, outline, and the boxes that must not move. */
const read = (page: Page, selector: string, index: number) =>
  page.evaluate(
    ({ selector, index }) => {
      // Computed colors may serialize as color(srgb …); a canvas turns each into "r,g,b,a".
      const context = document.createElement("canvas").getContext("2d")!;
      const rgba = (color: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data].join();
      };
      const probe = Object.fromEntries(
        [...document.querySelectorAll<HTMLElement>("[data-probe]")].map((node) => [
          node.dataset.probe!,
          rgba(getComputedStyle(node).backgroundColor),
        ]),
      );
      const card = document.querySelectorAll(selector)[index]!;
      const s = getComputedStyle(card);
      const shadows = [
        ...s.boxShadow.matchAll(/(rgba?\([^)]*\)|color\([^)]*\)) (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px( inset)?/g),
      ];
      const border = parseFloat(s.borderTopWidth);
      const inset = shadows.filter((shadow) => shadow[6]);
      const edgeColors = new Set(inset.map((shadow) => rgba(shadow[1]!)));
      if (border > 0) edgeColors.add(rgba(s.borderTopColor));
      const text = card.querySelector(".k2b-choice-list__label, .k2b-checkbox-card__label")!;
      const box = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return [x, y, width, height].map((value) => Math.round(value * 100) / 100).join();
      };
      return {
        probe,
        edgeWidth: border + inset.reduce((sum, shadow) => Math.max(sum, Number(shadow[5])), 0),
        edgeColors: [...edgeColors],
        outerShadows: shadows.filter((shadow) => !shadow[6]).length,
        outline: s.outlineStyle === "none" || parseFloat(s.outlineWidth) === 0 ? "none" : s.outlineStyle,
        fill: rgba(s.backgroundColor),
        card: box(card),
        text: box(text),
        focusVisible: card.matches(":focus-visible, :has(> input:focus-visible)"),
      };
    },
    { selector, index },
  );

const cards = [
  {
    name: "choice card",
    selector: ".k2b-choice-list__option",
    rest: 1,
    chosen: 0,
    choose: (page: Page) => page.locator(".k2b-choice-list__option").nth(1).click(),
  },
  {
    name: "checkbox card",
    selector: ".k2b-checkbox-card",
    rest: 1,
    chosen: 0,
    choose: (page: Page) => page.locator(".k2b-checkbox-card").nth(1).click(),
  },
] as const;

for (const theme of ["light", "dark"] as const)
  describe(`choice cards in ${theme}`, () => {
    for (const card of cards)
      test(
        `${card.name}: one 2 px edge in rest, hover, focus, chosen and chosen with focus, without shadow or movement`,
        async () => {
          const page = await load(theme);
          try {
            await page.mouse.move(890, 890);
            await settled(page);
            const rest = await read(page, card.selector, card.rest);
            const p = rest.probe;
            expect(rest.edgeWidth).toBe(2);
            expect(rest.edgeColors).toEqual([p.edge!]);
            expect(rest.fill).toBe(p.surface!);

            await page.locator(card.selector).nth(card.rest).hover();
            await settled(page);
            const hover = await read(page, card.selector, card.rest);
            expect(hover.edgeColors).toEqual([p.edge!]);
            expect(hover.fill).toBe(p.hover!);

            const chosen = await read(page, card.selector, card.chosen);
            expect(chosen.edgeWidth).toBe(2);
            expect(chosen.edgeColors).toEqual([p.selected!]);
            expect(chosen.fill).toBe(p.selectedFill!);
            await page.locator(card.selector).nth(card.chosen).hover();
            await settled(page);
            expect((await read(page, card.selector, card.chosen)).fill).toBe(p.selectedHover!);

            // Keyboard focus: a key press makes the next focus visible.
            await page.mouse.move(890, 890);
            await page.keyboard.press("Shift");
            const focusTarget = card.name === "choice card" ? card.selector : `${card.selector} > input`;
            await page.locator(focusTarget).nth(card.rest).focus();
            await settled(page);
            const focus = await read(page, card.selector, card.rest);
            expect(focus.focusVisible).toBe(true);
            expect(focus.edgeColors).toEqual([p.focus!]);
            expect(focus.edgeWidth).toBe(2);
            expect(focus.fill).toBe(p.surface!);

            await page.locator(focusTarget).nth(card.chosen).focus();
            await settled(page);
            const chosenFocus = await read(page, card.selector, card.chosen);
            expect(chosenFocus.focusVisible).toBe(true);
            expect(chosenFocus.edgeColors).toEqual([p.focus!]);
            expect(chosenFocus.fill).toBe(p.selectedFill!);

            for (const state of [rest, hover, chosen, focus, chosenFocus]) {
              expect(state.outerShadows).toBe(0);
              expect(state.outline).toBe("none");
            }
            // The card and its first text line stay on the same pixels in every state.
            expect(hover.card).toBe(rest.card);
            expect(hover.text).toBe(rest.text);
            expect(focus.card).toBe(rest.card);
            expect(focus.text).toBe(rest.text);
            expect(chosenFocus.card).toBe(chosen.card);
            expect(chosenFocus.text).toBe(chosen.text);

            // Choosing the other card swaps only paint.
            await card.choose(page);
            await page.mouse.move(890, 890);
            await settled(page);
            // A pointer choice leaves no visible focus, so the card shows the chosen edge.
            const after = await read(page, card.selector, card.rest);
            expect(after.focusVisible).toBe(false);
            expect(after.edgeColors).toEqual([p.selected!]);
            expect(after.fill).toBe(p.selectedFill!);
            expect(after.card).toBe(rest.card);
            expect(after.text).toBe(rest.text);
          } finally {
            await page.close();
          }
        },
        TEST_TIMEOUT,
      );

    test(
      "an invalid checkbox card has a red edge, a disabled card no edge on a muted fill, and the input variant is the same card",
      async () => {
        const page = await load(theme);
        try {
          const plain = await read(page, ".k2b-checkbox-card", 1);
          const input = await read(page, ".k2b-checkbox-card", 2);
          const invalid = await read(page, ".k2b-checkbox-card", 3);
          const locked = await read(page, ".k2b-checkbox-card", 4);
          const lockedChoice = await read(page, ".k2b-choice-list__option", 5);
          const p = plain.probe;
          expect(input.edgeColors).toEqual(plain.edgeColors);
          expect(input.fill).toBe(plain.fill);
          expect(invalid.edgeColors).toEqual([p.danger!]);
          expect(invalid.fill).toBe(p.surface!);
          for (const state of [locked, lockedChoice]) {
            expect(state.edgeColors.every((color) => color.endsWith(",0"))).toBe(true);
            expect(state.outerShadows).toBe(0);
          }
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

    test(
      "choice cards share a row while each gets 11rem, stack on a phone, and cards in one row share their height",
      async () => {
        for (const [width, columns] of [
          [900, [2, 3]],
          [390, [1, 1]],
        ] as const) {
          const page = await load(theme, width);
          try {
            const rows = await page.locator(".k2b-choice-list").evaluateAll((lists) =>
              lists.slice(0, 2).map((list) => {
                const boxes = [...list.querySelectorAll(".k2b-choice-list__option")].map((option) => option.getBoundingClientRect());
                const tops = [...new Set(boxes.map((box) => box.top))];
                const rowHeights = tops.map((top) => new Set(boxes.filter((box) => box.top === top).map((box) => box.height)).size);
                return { tops: tops.length, heights: Math.max(...rowHeights), count: boxes.length };
              }),
            );
            // Columns per list: Billing has two cards, Repeat three.
            expect(rows.map((row) => row.count / row.tops)).toEqual([...columns]);
            for (const row of rows) expect(row.heights).toBe(1);
          } finally {
            await page.close();
          }
        }
      },
      TEST_TIMEOUT,
    );
  });
