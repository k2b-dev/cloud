import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { Dynamic, renderToString } from "solid-js/web";
import { launchBrowser, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";
import { workspaceCss } from "../../test/workspace-host-fixture";
import { layoutProblems } from "../layout-check";

// Error class (flat QA v12, B0–B2): the status row's filters scrolled sideways or were cut at the edge without a
// sign, at 768 px in a Kanban (229 px too wide) and at 1440 px (a sixth chip). K15: from 768 px the filters never
// scroll. Those that do not fit fold behind "Filters +n", which opens the same filters, with their state, below the
// row; the row moves nothing. The server frame is the final frame: the row's script folds before the page paints.
// A phone scrolls the filters sideways with a fade at the edge where they continue.
const directory = mkdtempSync(resolve(tmpdir(), "k2b-status-row-filters-"));
registerSsrTestPlugin({ dev: true, rootDir: directory });
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));

const { StatusRow } = await import("./StatusRow");
const { FilterChip } = await import("../actions/FilterChip");
const { LocaleProvider } = await import("../intl/locale");
const { Button } = await import("../actions/Button");

const ui = resolve(import.meta.dir, "../..");
const el = (component: string, props: Record<string, unknown>) => createComponent(Dynamic, { component, ...props });
const css = workspaceCss();
const labels = ["Tags", "Assigned to", "Due date", "Priority", "Created by", "Space", "Board column", "Attachments"];
// The same row for the server and for the client, so both frames can be compared.
const row = () =>
  createComponent(LocaleProvider, {
    locale: "en",
    get children() {
      return createComponent(StatusRow, {
        lead: "128 tasks",
        facts: [
          { value: "12", label: "open" },
          { value: "3", label: "overdue" },
        ],
        get filters() {
          return labels.map((label, index) =>
            createComponent(FilterChip, {
              label,
              icon: "ti ti-filter",
              value: index === 1 ? ["me"] : [],
              onValueChange: () => {},
              options: [
                {
                  options: [
                    { value: "me", label: "Me" },
                    { value: "team", label: "Team" },
                  ],
                },
              ],
            }),
          );
        },
      });
    },
  });
const serverHtml = renderToString(row);
const entry = resolve(import.meta.dir, "status-row-filters.fixture.ts");
const build = await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: `
import { createComponent, render } from "solid-js/web";
import { FilterChip, LocaleProvider, StatusRow } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
const labels = ${JSON.stringify(labels)};
render(() => createComponent(LocaleProvider, { locale: "en", get children() {
  return createComponent(StatusRow, {
    lead: "128 tasks",
    facts: [{ value: "12", label: "open" }, { value: "3", label: "overdue" }],
    get filters() {
      return labels.map((label, index) => createComponent(FilterChip, {
        label, icon: "ti ti-filter", value: index === 1 ? ["me"] : [], onValueChange: () => {},
        options: [{ options: [{ value: "me", label: "Me" }, { value: "team", label: "Team" }] }],
      }));
    },
  });
} }), document.getElementById("app"));
`,
  },
  target: "browser",
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the status row filters fixture.");
const client = await build.outputs[0]!.text();

let browser: Browser;
setDefaultTimeout(30_000);
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** The row in a host of `host` px inside a window of `viewport` px, as a page beside Detail or the panel has it. */
const open = async (viewport: number, host: number, body: "server" | "client") => {
  const phone = viewport < 768;
  const page = await browser.newPage({
    viewport: { width: viewport, height: 700 },
    reducedMotion: "reduce",
    isMobile: phone,
    hasTouch: phone,
  });
  // The first painted frame: this frame callback queues after the row's own, which the parser registered earlier.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () =>
      requestAnimationFrame(() => {
        (window as unknown as { firstFrame: unknown }).firstFrame = [...document.querySelectorAll(".k2b-status-row__filters > *")].map(
          (item) => item.hasAttribute("data-fit-hidden"),
        );
      }),
    );
  });
  const html = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="app" style="width:${host}px">${body === "server" ? serverHtml : ""}</div><button id="after">After</button></body></html>`;
  // A navigation, so the init script sees the page load as a browser does.
  await page.route("http://status-row.test/**", (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto("http://status-row.test/");
  if (body === "client") await page.addScriptTag({ content: client });
  await page.locator(".k2b-status-row").waitFor();
  await settled(page);
  return page;
};

const shape = (page: Page) =>
  page.evaluate(() => {
    const row = document.querySelector<HTMLElement>(".k2b-status-row")!;
    const box = row.getBoundingClientRect();
    const group = row.querySelector<HTMLElement>(".k2b-status-row__filters")!;
    const more = row.querySelector<HTMLElement>(".k2b-status-row__more")!;
    const chips = [...group.children].map((item) => {
      const rect = item.getBoundingClientRect();
      const shown = getComputedStyle(item).visibility !== "hidden";
      return {
        shown,
        // A shown filter lies whole inside the row and inside its group's first line.
        whole:
          rect.left >= box.left - 0.5 &&
          rect.right <= box.right + 0.5 &&
          rect.top >= group.getBoundingClientRect().top - 0.5 &&
          rect.bottom <= group.getBoundingClientRect().bottom + 0.5,
      };
    });
    return {
      height: Math.round(box.height),
      sideways: [row, group, row.querySelector<HTMLElement>(".k2b-status-row__end")!]
        .filter((element) => getComputedStyle(element).overflowX !== "visible" && element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.className),
      chips,
      hidden: chips.filter((chip) => !chip.shown).length,
      button: more.hidden ? null : more.textContent!.replace(/\s+/g, " ").trim(),
      buttonWhole: more.hidden || more.getBoundingClientRect().right <= box.right + 0.5,
      // Nothing folds that would still fit: the first folded filter is wider than the room left on the first line.
      overFolded: (() => {
        const shown = [...group.children].filter((item) => getComputedStyle(item).visibility !== "hidden");
        const folded = [...group.children].find((item) => getComputedStyle(item).visibility === "hidden");
        if (!folded || shown.length === 0) return false;
        const room = shown[0]!.getBoundingClientRect().left - group.getBoundingClientRect().left;
        return folded.getBoundingClientRect().width + Number.parseFloat(getComputedStyle(group).columnGap) <= room;
      })(),
    };
  });

for (const [viewport, host] of [
  [768, 768],
  [1100, 1100],
  [1440, 1440],
  [1440, 640],
] as const)
  test(`${host} px host at ${viewport} px: no filter scrolls or is cut, "Filters +n" counts the folded ones, and the server frame is final`, async () => {
    const server = await open(viewport, host, "server");
    const clientPage = await open(viewport, host, "client");
    try {
      const frame = await shape(server);
      expect(frame.height).toBe(52);
      expect(frame.sideways).toEqual([]);
      // Every filter is whole on the row's line, or folded and hidden; the button counts exactly the folded ones.
      for (const chip of frame.chips) expect(chip.shown ? chip.whole : true).toBe(true);
      expect(frame.button).toBe(frame.hidden > 0 ? `Filters +${frame.hidden}` : null);
      expect(frame.buttonWhole).toBe(true);
      expect(frame.overFolded).toBe(false);
      expect((await server.evaluate(layoutProblems, { root: ".k2b-status-row" })).problems).toEqual([]);
      // The first painted frame already folded, and a client render folds the same filters.
      expect(await server.evaluate(() => (window as unknown as { firstFrame: boolean[] }).firstFrame)).toEqual(
        frame.chips.map((chip) => !chip.shown),
      );
      const rendered = await shape(clientPage);
      expect({ chips: rendered.chips, button: rendered.button }).toEqual({ chips: frame.chips, button: frame.button });
      // Something folds where the row is narrow, nothing where the eight filters fit.
      if (host <= 768) expect(frame.hidden).toBeGreaterThan(0);
      if (host === 1440) expect(frame.hidden).toBe(0);
    } finally {
      await server.close();
      await clientPage.close();
    }
  });

test("the keyboard opens the folded filters below the row, reaches each one and its menu, and Escape returns to the button", async () => {
  const page = await open(768, 768, "client");
  try {
    const before = await shape(page);
    expect(before.hidden).toBeGreaterThan(0);
    const rowBox = await page.locator(".k2b-status-row").boundingBox();
    const button = page.locator(".k2b-status-row__more button");
    await button.focus();
    await page.keyboard.press("Enter");
    await settled(page);
    expect(await button.getAttribute("aria-expanded")).toBe("true");
    // The first folded filter takes focus; all filters show, the folded ones below the row; the row moves nothing.
    const opened = await page.evaluate(() => {
      const row = document.querySelector(".k2b-status-row")!.getBoundingClientRect();
      const items = [...document.querySelectorAll<HTMLElement>(".k2b-status-row__filters > *")];
      const folded = items.filter((item) => item.hasAttribute("data-fit-hidden"));
      return {
        focusInFirstFolded: folded[0]!.contains(document.activeElement),
        allShown: items.every((item) => getComputedStyle(item).visibility !== "hidden"),
        foldedBelow: folded.every((item) => item.getBoundingClientRect().top >= row.bottom - 8),
        foldedInWindow: folded.every(
          (item) => item.getBoundingClientRect().right <= window.innerWidth && item.getBoundingClientRect().left >= 0,
        ),
      };
    });
    expect(opened).toEqual({ focusInFirstFolded: true, allShown: true, foldedBelow: true, foldedInWindow: true });
    expect(await page.locator(".k2b-status-row").boundingBox()).toEqual(rowBox);
    // Tab moves through the folded filters; a filter's own menu opens and closes first on Escape.
    await page.keyboard.press("Enter");
    await settled(page);
    expect(await page.locator(".k2b-status-row__filters :popover-open").count()).toBe(1);
    await page.keyboard.press("Escape");
    await settled(page);
    expect(await page.locator(".k2b-status-row__filters :popover-open").count()).toBe(0);
    expect(await button.getAttribute("aria-expanded")).toBe("true");
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(() => {
        const folded = [...document.querySelectorAll(".k2b-status-row__filters > [data-fit-hidden]")];
        return folded.length < 2 || folded[1]!.contains(document.activeElement);
      }),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await settled(page);
    expect(await button.getAttribute("aria-expanded")).toBe("false");
    expect(await button.evaluate((element) => document.activeElement === element)).toBe(true);
    expect(await shape(page)).toEqual(before);
    // A press outside closes it too.
    await button.click();
    await settled(page);
    await page.mouse.click(5, 600);
    await settled(page);
    expect(await button.getAttribute("aria-expanded")).toBe("false");
    // So does focus leaving the filters and their button.
    await button.click();
    await settled(page);
    await page.locator("#after").focus();
    await settled(page);
    expect(await button.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await page.close();
  }
});

test("a phone scrolls the filters sideways with a fade at the edge where they continue, and folds nothing", async () => {
  const page = await open(390, 390, "server");
  try {
    const phone = await page.evaluate(() => {
      const group = document.querySelector<HTMLElement>(".k2b-status-row__filters")!;
      return {
        scrolls: group.scrollWidth > group.clientWidth + 1 && getComputedStyle(group).overflowX === "auto",
        folded: document.querySelectorAll("[data-fit-hidden]").length,
        button: !document.querySelector<HTMLElement>(".k2b-status-row__more")!.hidden,
        timelines: CSS.supports("animation-timeline: scroll()"),
        mask: getComputedStyle(group).maskImage || getComputedStyle(group).getPropertyValue("-webkit-mask-image"),
      };
    });
    expect({ scrolls: phone.scrolls, folded: phone.folded, button: phone.button }).toEqual({ scrolls: true, folded: 0, button: false });
    // The trailing edge fades where the filters continue (with scroll timelines; without them the edge stays).
    if (phone.timelines) expect(phone.mask).toContain("gradient");
  } finally {
    await page.close();
  }
});

// L6 (flat QA): with `flex: none` the end grew as wide as its content and the whole status band ran past its column.
// A selection's actions keep their width while the figures give way; where they still do not fit, the end scrolls
// them itself, so the row stays inside its column and no action is cut.
test("768 px: a selection's many actions scroll inside the end; the row never runs past its column", async () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(StatusRow, {
          lead: "128 tasks",
          filters: [],
          selection: {
            count: 3,
            facts: [{ value: "2", label: "overdue" }],
            get actions() {
              return [
                "Move to another board",
                "Assign to someone",
                "Set a due date",
                "Add tags",
                "Duplicate",
                "Archive",
                "Export as CSV",
              ].map((label) => createComponent(Button, { size: "sm", variant: "secondary", children: label }));
            },
          },
        });
      },
    }),
  );
  const page = await browser.newPage({ viewport: { width: 768, height: 700 }, reducedMotion: "reduce" });
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="app" style="width:768px">${html}</div></body></html>`,
    );
    await settled(page);
    const band = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".k2b-status-row")!;
      const end = row.querySelector<HTMLElement>(".k2b-status-row__end")!;
      return {
        rowSideways: row.scrollWidth - row.clientWidth,
        rowInside: row.getBoundingClientRect().right <= document.getElementById("app")!.getBoundingClientRect().right + 0.5,
        endScrolls: end.scrollWidth > end.clientWidth + 1 && getComputedStyle(end).overflowX === "auto",
        height: Math.round(row.getBoundingClientRect().height),
      };
    });
    expect(band).toEqual({ rowSideways: 0, rowInside: true, endScrolls: true, height: 52 });
  } finally {
    await page.close();
  }
});

// Opus review: filters of mixed heights (a 36 px chip before 28 px buttons) and several filters inside one island
// wrapper (`display: contents`) count one by one; a shorter filter on the first line never folds, and none is cut.
test("768 px: filters of mixed heights and inside an island wrapper fold one by one, and none is cut", async () => {
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "en",
      get children() {
        return createComponent(StatusRow, {
          lead: "128 tasks",
          get filters() {
            const chip = (label: string) =>
              createComponent(FilterChip, {
                label,
                icon: "ti ti-filter",
                value: [],
                onValueChange: () => {},
                options: [{ options: [{ value: "a", label: "A" }] }],
              });
            const button = (label: string) => createComponent(Button, { size: "sm", variant: "secondary", children: label });
            return [
              chip("Tags"),
              button("Mine"),
              button("Today"),
              // An island wrapper draws no box; its filters count one by one.
              el("solid-island", {
                style: "display:contents",
                get children() {
                  return [button("Overdue"), button("Waiting"), button("Blocked")];
                },
              }),
              chip("Assigned to"),
              chip("Created by"),
              chip("Board column"),
            ];
          },
        });
      },
    }),
  );
  const page = await browser.newPage({ viewport: { width: 768, height: 700 }, reducedMotion: "reduce" });
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0"><div id="app" style="width:768px">${html}</div></body></html>`,
    );
    await settled(page);
    const result = await page.evaluate(() => {
      const row = document.querySelector<HTMLElement>(".k2b-status-row")!.getBoundingClientRect();
      const group = document.querySelector<HTMLElement>(".k2b-status-row__filters")!;
      const line = group.getBoundingClientRect();
      const flat = (item: Element): Element[] =>
        getComputedStyle(item).display === "contents" ? [...item.children].flatMap(flat) : [item];
      const items = [...group.children].flatMap(flat);
      const shown = items.filter((item) => getComputedStyle(item).visibility !== "hidden");
      return {
        items: items.length,
        hidden: items.length - shown.length,
        cut: shown.filter((item) => {
          const rect = item.getBoundingClientRect();
          return rect.left < row.left - 0.5 || rect.right > row.right + 0.5 || rect.top < line.top - 0.5 || rect.bottom > line.bottom + 0.5;
        }).length,
        // The two short buttons right after the tall first chip stay on the first line.
        shortKept: shown.length >= 3,
        button: document.querySelector<HTMLElement>(".k2b-status-row__more")!.hidden
          ? null
          : document.querySelector(".k2b-status-row__more")!.textContent!.replace(/\s+/g, " ").trim(),
      };
    });
    expect(result.items).toBe(9);
    expect(result.cut).toBe(0);
    expect(result.shortKept).toBe(true);
    expect(result.hidden).toBeGreaterThan(0);
    expect(result.button).toBe(`Filters +${result.hidden}`);
    expect((await page.evaluate(layoutProblems, { root: ".k2b-status-row" })).problems).toEqual([]);
  } finally {
    await page.close();
  }
});
