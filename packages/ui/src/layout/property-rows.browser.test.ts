import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";

// Whether a row's surface, hit area, and columns stay put is a question of
// layout and paint, which happy-dom does not model, so a real engine runs the
// shipped browser build.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
// Fonts load from the build through a routed origin, so screenshots show the real icons and type.
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");

const entry = resolve(import.meta.dir, "property-rows.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { DateTimePicker, DescriptionList, DetailPanel, MultiSelectInput, NumberInput, Select } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const priorities = [
  { id: "urgent", label: "Urgent", color: "#ef4444" },
  { id: "medium", label: "Medium", color: "#eab308" },
];
const tags = [
  { id: "a", label: "Hardware", color: "#2563eb" },
  { id: "b", label: "Office", color: "#16a34a" },
];
const rows = (filled) => {
  const [due, setDue] = createSignal(filled ? "2026-10-06T17:00" : null);
  const [estimate, setEstimate] = createSignal(filled ? 45 : null);
  const [priority, setPriority] = createSignal(filled ? "medium" : null);
  const [tagIds, setTagIds] = createSignal(filled ? ["a", "b"] : []);
  return [
    { term: "Owner", description: "Platform team" },
    { term: "Due", description: createComponent(DateTimePicker, { "aria-label": "Due", appearance: "plain", placeholder: "No due date", clearable: true, value: due, onValueChange: setDue }) },
    { term: "Estimate", description: createComponent(NumberInput, { "aria-label": "Estimate", appearance: "plain", placeholder: "No estimate", suffix: "min", min: 1, value: estimate, onValueCommit: setEstimate }) },
    { term: "Priority", description: createComponent(Select, { "aria-label": "Priority", appearance: "plain", placeholder: "No priority", clearable: true, value: priority, options: priorities, onValueChange: setPriority }) },
    { term: "Tags", description: createComponent(MultiSelectInput, { "aria-label": "Tags", appearance: "plain", placeholder: "Tag", placeholderIcon: "ti ti-plus", value: tagIds, options: tags, onValueChange: setTagIds }) },
  ];
};
const list = (filled) => createComponent(DescriptionList, { layout: "rows", size: "sm", items: rows(filled), class: filled ? "filled" : "empty" });

render(
  () =>
    createComponent(DetailPanel, {
      get children() {
        return createComponent(DetailPanel.Body, {
          scrollFade: false,
          get children() {
            return [
              createComponent(DetailPanel.Summary, { title: "Planning", get children() { return [list(true), list(false)]; } }),
              createComponent(DetailPanel.Group, {
                label: "Note context",
                get children() {
                  return [
                    createComponent(DetailPanel.Section, { title: "Online", icon: "ti ti-users", meta: "1", children: "Robin Example" }),
                    createComponent(DetailPanel.Section, { title: "Recent activity", icon: "ti ti-history", meta: "2", collapsible: true, children: "Edited twice" }),
                    createComponent(DetailPanel.Section, { title: "Information", icon: "ti ti-info-circle", collapsible: true, defaultOpen: true, children: "Created yesterday" }),
                  ];
                },
              }),
            ];
          },
        });
      },
    }),
  document.getElementById("app"),
);

// Boxed fields in a narrow form: a long placeholder ends in an ellipsis.
const narrow = document.createElement("div");
narrow.id = "narrow";
narrow.style.width = "150px";
document.body.append(narrow);
const long = "Select a very long placeholder";
render(
  () => [
    createComponent(Select, { "aria-label": "Long select", placeholder: long, options: priorities, value: null }),
    createComponent(MultiSelectInput, { "aria-label": "Long tags", placeholder: long, placeholderIcon: "ti ti-plus", options: tags, value: [] }),
  ],
  narrow,
);
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the property row fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Theme = "light" | "dark";
const load = async (width: number, theme: Theme) => {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>${fonts}</style>` +
      "<style>*,*::before,*::after{transition:none!important}</style></head>" +
      `<body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}" style="margin:0;background:var(--k2b-surface-canvas)">` +
      `<div id="app" style="width:min(24rem,100%);height:60rem;padding:0.75rem;box-sizing:border-box"></div></body></html>`,
  );
  await page.addScriptTag({ content: script });
  await page.getByRole("button", { name: "Recent activity" }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(width - 2, 990);
  return page;
};

/** Every box in the panel, except the pickers' panels in the top layer. */
const boxes = (page: Page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll(".k2b-detail-panel *"))
      .filter((element) => !element.closest(".k2b-choice-popover, .k2b-date-popover"))
      .filter((element) => getComputedStyle(element).display !== "none" && !element.closest("[hidden]"))
      .map((element) => {
        const box = element.getBoundingClientRect();
        return `${element.className || element.tagName} ${[box.x, box.y, box.width, box.height].map((value) => value.toFixed(2)).join(" ")}`;
      }),
  );

const row = (page: Page, list: "filled" | "empty", term: string) =>
  page.locator(`.${list} .k2b-description-list__item`, { has: page.getByText(term, { exact: true }) });

const surface = (page: Page, list: "filled" | "empty", term: string) =>
  row(page, list, term).evaluate((item) => {
    const control = item.querySelector(".k2b-choice-trigger, .k2b-multi-select-trigger, .k2b-date-trigger, .k2b-number-input");
    return control ? getComputedStyle(control, "::before").backgroundColor : "none";
  });

const transparent = "rgba(0, 0, 0, 0)";
const editable = ["Due", "Estimate", "Priority", "Tags"] as const;

describe("@k2b/ui property rows and DetailPanel sections", () => {
  test("boxed Select and MultiSelectInput placeholders still end in an ellipsis", async () => {
    const page = await load(390, "light");
    try {
      const placeholders = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>("#narrow .k2b-choice-trigger__value[data-placeholder='true']"), (value) => {
          const style = getComputedStyle(value);
          return { display: style.display, overflow: style.textOverflow, cut: value.scrollWidth > value.clientWidth };
        }),
      );
      expect(placeholders).toEqual([
        { display: "block", overflow: "ellipsis", cut: true },
        { display: "block", overflow: "ellipsis", cut: true },
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);

  for (const width of [1440, 390]) {
    for (const theme of ["light", "dark"] as const) {
      test(`${width} px ${theme}: plain controls keep every box while hovered, focused, and open, and the whole row opens them`, async () => {
        const page = await load(width, theme);
        try {
          const rest = await boxes(page);
          await page.screenshot({ path: `/tmp/k2b-ui-property-rows-${width}-${theme}.png`, fullPage: true });

          // Every value starts in the same column as the plain text row.
          const columns = await page.evaluate(() =>
            Array.from(document.querySelectorAll(".k2b-description-list")).map((list) =>
              Array.from(list.querySelectorAll(":scope > .k2b-description-list__item > dd"), (dd) => {
                const first =
                  dd.querySelector(
                    ".k2b-choice-trigger > :not([hidden]), .k2b-choice-trigger__placeholder-icon, .k2b-choice-pill, .k2b-choice-trigger__value, .k2b-date-trigger__value, .k2b-number-input__sizer",
                  ) ?? dd;
                return Math.round(first.getBoundingClientRect().left);
              }),
            ),
          );
          for (const lefts of columns) expect(new Set(lefts).size).toBe(1);

          for (const list of ["filled", "empty"] as const) {
            for (const term of editable) {
              expect(await surface(page, list, term)).toBe(transparent);
              const box = (await row(page, list, term).locator("dt").boundingBox())!;
              await page.mouse.move(box.x + 4, box.y + box.height / 2);
              expect(await surface(page, list, term)).not.toBe(transparent);
              expect(await boxes(page)).toEqual(rest);
            }
          }
          await page.mouse.move(width - 2, 990);

          // A click on the label opens the picker or edits the number, without moving anything.
          for (const term of editable) {
            // The trigger's hit area covers the label, so the click lands on the label's position.
            const label = (await row(page, "filled", term).locator("dt").boundingBox())!;
            await page.mouse.click(label.x + 4, label.y + label.height / 2);
            const state = await row(page, "filled", term).evaluate((item) => ({
              expanded: item.querySelector("[aria-expanded]")?.getAttribute("aria-expanded") ?? null,
              editing: document.activeElement?.getAttribute("role") === "spinbutton" && item.contains(document.activeElement),
            }));
            expect(term === "Estimate" ? state.editing : state.expanded === "true").toBe(true);
            expect(await boxes(page)).toEqual(rest);
            if (term === "Priority")
              await page.screenshot({ path: `/tmp/k2b-ui-property-rows-${width}-${theme}-open.png`, fullPage: true });
            await page.keyboard.press("Escape");
            await page.mouse.click(width - 2, 990);
          }

          // Keyboard focus draws the ring on the row surface, also without moving anything.
          await page.locator(".filled .k2b-choice-trigger").focus();
          await page.keyboard.press("Shift+Tab");
          await page.keyboard.press("Tab");
          const ring = await row(page, "filled", "Priority").evaluate((item) => {
            const before = getComputedStyle(item.querySelector(".k2b-choice-trigger")!, "::before");
            return before.outlineStyle;
          });
          expect(ring).toBe("solid");
          expect(await boxes(page)).toEqual(rest);
        } finally {
          await page.close();
        }
      }, 60_000);

      test(`${width} px ${theme}: a collapsible section lines up with the other section headings in both states`, async () => {
        const page = await load(width, theme);
        try {
          const geometry = (title: string) =>
            page.evaluate((title) => {
              const section = Array.from(document.querySelectorAll(".k2b-detail-panel__section")).find((element) =>
                Array.from(element.querySelectorAll("h3, .k2b-detail-panel__section-title")).some(
                  (heading) => heading.textContent === title && !heading.closest("[hidden]"),
                ),
              )!;
              const visible = (selector: string) =>
                Array.from(section.querySelectorAll<HTMLElement>(selector)).find((element) => !element.closest("[hidden]"));
              const box = (element: Element | undefined) => {
                const rect = element!.getBoundingClientRect();
                return {
                  left: Math.round(rect.left),
                  center: Math.round(rect.left + rect.width / 2),
                  top: Math.round(rect.top),
                  height: Math.round(rect.height),
                };
              };
              const row = visible(".k2b-detail-panel__section-header, .k2b-detail-panel__section-summary");
              const chevron = visible(".k2b-detail-panel__section-toggle i");
              return {
                row: box(row),
                icon: box(visible(".k2b-detail-panel__section-icon")),
                title: box(visible("h3, .k2b-detail-panel__section-title")),
                meta: section.querySelector(".k2b-detail-panel__section-meta") ? box(visible(".k2b-detail-panel__section-meta")) : null,
                chevron: chevron ? box(chevron) : null,
                fill: getComputedStyle(row!).backgroundColor,
              };
            }, title);

          const plain = await geometry("Online");
          const closed = await geometry("Recent activity");
          const open = await geometry("Information");
          for (const state of [closed, open]) {
            expect(state.icon.left).toBe(plain.icon.left);
            expect(state.title.left).toBe(plain.title.left);
            expect(state.row.height).toBe(plain.row.height);
          }
          // The closed chevron sits where the open header's collapse button has its chevron.
          expect(closed.chevron?.center).toBe(open.chevron?.center);
          // Meta sits next to the chevron column in both states.
          expect(closed.meta!.left + 0).toBeLessThan(closed.chevron!.left);

          // Hover and keyboard focus leave the row where it is and paint no pill.
          const before = await boxes(page);
          await page.getByRole("button", { name: /Recent activity/ }).hover();
          const hovered = await geometry("Recent activity");
          expect(hovered.fill).toBe(transparent);
          expect(await boxes(page)).toEqual(before);
          await page.getByRole("button", { name: /Recent activity/ }).focus();
          expect(await boxes(page)).toEqual(before);

          // Opening keeps the icon, title, and chevron columns.
          await page.getByRole("button", { name: /Recent activity/ }).click();
          const opened = await geometry("Recent activity");
          expect(opened.icon).toEqual(closed.icon);
          expect(opened.title.left).toBe(closed.title.left);
          expect(opened.chevron?.center).toBe(closed.chevron?.center);
          expect(opened.row.height).toBe(closed.row.height);
          expect(await page.getByRole("button", { name: "Recent activity" }).getAttribute("aria-expanded")).toBe("true");
          await page.screenshot({ path: `/tmp/k2b-ui-detail-sections-${width}-${theme}.png`, fullPage: true });
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }
});
