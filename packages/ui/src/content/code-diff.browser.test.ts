import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../test/browser";

// Fold and mark geometry, sideways scrolling inside the component's own width, focus after revealing rows, and contrast are results
// of layout and paint, so a real engine renders the shipped stylesheet. Fixtures are fictional.
declare global {
  interface Window {
    axe?: typeof axeCore;
  }
}

const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");
const axeSource = readFileSync(Bun.resolveSync("axe-core/axe.min.js", import.meta.dir), "utf8");

const entry = resolve(import.meta.dir, "code-diff.fixture.ts");
const fixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { CodeDiff } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const same = (text) => ({ kind: "same", text });
const add = (text) => ({ kind: "add", text });
const del = (text) => ({ kind: "del", text });
const head = Array.from({ length: 12 }, (_, index) => same("const step" + (index + 1) + " = " + (index + 1) + ";"));
const long = "  await message.reply({ messageId: event.messageId, text, subject: 'Your callback request', cc: [], bcc: [], priority: 'normal' });";
const files = [
  { path: "index.ts", lines: [...head, del("  await draft.create({ text });"), add("  // Reply to the sender of the event"), add(long), same("}"), same(""), same("// done")] },
  { path: "reply.test.ts", lines: [same("test('replies', () => {"), ...Array.from({ length: 900 }, (_, index) => add("  expect(sent[" + index + "]).toBeDefined();")), same("});")] },
  { path: "params.ts", lines: [same("export const params = {"), same("  window: 2,"), same("};")] },
];
const [mark, setMark] = createSignal();
const [shownFiles, setShownFiles] = createSignal(files);
const [status, setStatus] = createSignal();
window.setMark = setMark;
window.setStatus = setStatus;
window.setFiles = (paths) => setShownFiles(files.filter((file) => paths.includes(file.path)));
window.changes = [];
render(
  () =>
    createComponent(CodeDiff, {
      get files() {
        return shownFiles();
      },
      get mark() {
        return mark();
      },
      get status() {
        return status();
      },
      onRetry: () => {},
      onFileChange: (path) => window.changes.push(path),
    }),
  document.getElementById("app"),
);
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the CodeDiff fixture for the browser.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

type Fixture = {
  setMark: (mark?: { path: string; line: number; side?: "old" | "new" }) => void;
  setFiles: (paths: string[]) => void;
  setStatus: (status?: "loading" | "error") => void;
  changes: string[];
};
const fixtureCall = (page: Page, call: string) => page.evaluate(`window.${call}`);

/** The component in a column of `width` px, in a viewport short enough that a far line must scroll. */
const open = async (width: number, theme?: "dark", shell = false): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: Math.max(width + 48, 390), height: 700 }, reducedMotion: "reduce" });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  const html =
    '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>CodeDiff</title>' +
    `<style>${css}</style><style>${fonts}</style></head>` +
    `<body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}" style="margin:0;background:var(--k2b-surface)">` +
    (shell
      ? // An app shell that clips its overflow around a scrolling column, like a workspace level.
        `<div id="shell" style="height:100vh;overflow:hidden"><header style="height:160px"></header>` +
        `<main id="column" style="height:calc(100% - 160px);overflow:auto;padding:24px">` +
        `<div style="height:400px"></div><div id="app" style="width:${width}px"></div></main><div style="height:200px"></div></div></body></html>`
      : `<main style="padding:24px"><div id="app" style="width:${width}px"></div></main></body></html>`);
  await page.route(`${assets}page`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  await page.goto(`${assets}page`);
  await page.evaluate(() =>
    Promise.all(["400 13px 'IBM Plex Mono'", "400 15px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font))),
  );
  await page.addScriptTag({ content: script });
  await settled(page);
  return page;
};
const rect = (page: Page, selector: string) =>
  page.evaluate((value) => {
    const box = document.querySelector(value)!.getBoundingClientRect();
    return { top: box.top, height: box.height, width: box.width };
  }, selector);
const region = (page: Page) => page.evaluate(() => document.querySelector(".k2b-code-diff__body")!.getAttribute("aria-label"));

describe("CodeDiff in a browser", () => {
  test("a fold opens in place: rows above stay put and focus lands on the first revealed row", async () => {
    const page = await open(560);
    try {
      const fold = await rect(page, ".k2b-code-diff__fold");
      const files = await rect(page, ".k2b-code-diff__files .k2b-tabs__bar");
      await page.focus(".k2b-code-diff__fold");
      await page.keyboard.press("Enter");
      await settled(page);
      expect(await page.locator(".k2b-code-diff__fold").count()).toBe(0);
      expect(await rect(page, ".k2b-code-diff__files .k2b-tabs__bar")).toEqual(files);
      expect((await rect(page, '[data-row="0"]')).top).toBe(fold.top);
      expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.row)).toBe("0");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("arrow keys switch files, and a mark switches to its file and scrolls its line into view without moving rows", async () => {
    const page = await open(560);
    try {
      await page.focus('[role="tab"][aria-selected="true"]');
      await page.keyboard.press("ArrowRight");
      await settled(page);
      expect(await region(page)).toBe("Code difference, read only · reply.test.ts");
      await page.keyboard.press("ArrowRight");
      await settled(page);
      expect(await region(page)).toBe("Code difference, read only · params.ts");

      // Line 14 of index.ts: the long added line. Same height marked and unmarked.
      await page.evaluate(() => (window as unknown as Fixture).setMark({ path: "index.ts", line: 14 }));
      await settled(page);
      expect(await region(page)).toBe("Code difference, read only · index.ts");
      const marked = await rect(page, '[data-marked="true"]');
      await page.evaluate(() => (window as unknown as Fixture).setMark(undefined));
      await settled(page);
      expect(await rect(page, '[data-row="14"]')).toEqual(marked);

      // A line on the second page of a long file: its page renders, the line is centred in the viewport.
      await page.evaluate(() => (window as unknown as Fixture).setMark({ path: "reply.test.ts", line: 700 }));
      await settled(page);
      const far = await rect(page, '[data-marked="true"]');
      expect(far.top).toBeGreaterThan(0);
      expect(far.top + far.height).toBeLessThan(700);
      expect(await page.evaluate(() => (window as unknown as Fixture).changes)).toEqual([
        "reply.test.ts",
        "params.ts",
        "index.ts",
        "reply.test.ts",
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a mark centres its line in the nearest scrolling column and leaves the shell and the page alone", async () => {
    const page = await open(560, undefined, true);
    try {
      await page.evaluate(() => (window as unknown as Fixture).setMark({ path: "reply.test.ts", line: 700 }));
      await settled(page);
      const measured = await page.evaluate(() => {
        const column = document.getElementById("column")!;
        const frame = column.getBoundingClientRect();
        const row = document.querySelector('[data-marked="true"]')!.getBoundingClientRect();
        return {
          page: window.scrollY,
          shell: document.getElementById("shell")!.scrollTop,
          column: column.scrollTop > 0,
          offCentre: Math.abs(row.top + row.height / 2 - (frame.top + column.clientTop + column.clientHeight / 2)),
        };
      });
      expect({ ...measured, offCentre: measured.offCentre <= 1 }).toEqual({ page: 0, shell: 0, column: true, offCentre: true });

      // The person scrolls away and marks the same line again: a new mark is a new request.
      const before = await page.evaluate(() => {
        const column = document.getElementById("column")!;
        const top = column.scrollTop;
        column.scrollTop = 0;
        return top;
      });
      await page.evaluate(() => (window as unknown as Fixture).setMark({ path: "reply.test.ts", line: 700 }));
      await settled(page);
      expect(await page.evaluate(() => document.getElementById("column")!.scrollTop)).toBe(before);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("a mark in a page whose root scrolls centres the line in the viewport from any scroll position", async () => {
    const page = await open(560);
    try {
      await page.evaluate(() => {
        document.documentElement.style.overflowY = "auto";
        window.scrollTo({ top: 300, behavior: "instant" });
      });
      await page.evaluate(() => (window as unknown as Fixture).setMark({ path: "reply.test.ts", line: 700 }));
      await settled(page);
      const offCentre = await page.evaluate(() => {
        const row = document.querySelector('[data-marked="true"]')!.getBoundingClientRect();
        return Math.abs(row.top + row.height / 2 - window.innerHeight / 2);
      });
      expect(offCentre).toBeLessThanOrEqual(1);
    } finally {
      await page.close();
    }
  }, 30_000);

  test("Show more renders the next page and moves focus to its first row", async () => {
    const page = await open(560);
    try {
      await page.click('[role="tab"]:has-text("reply.test.ts")');
      await settled(page);
      expect(await page.locator(".k2b-code-diff__line").count()).toBe(400);
      await page.click(".k2b-code-diff__more button");
      await settled(page);
      expect(await page.locator(".k2b-code-diff__line").count()).toBe(800);
      expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.row)).toBe("400");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("what a mark revealed stays when the mark goes away, and a mark waits for its file to arrive", async () => {
    const page = await open(560);
    try {
      await fixtureCall(page, 'setMark({ path: "reply.test.ts", line: 700 })');
      await settled(page);
      expect(await page.locator(".k2b-code-diff__line").count()).toBe(800);
      await fixtureCall(page, "setMark(undefined)");
      await settled(page);
      expect(await region(page)).toBe("Code difference, read only · reply.test.ts");
      expect(await page.locator(".k2b-code-diff__line").count()).toBe(800);

      // The marked file is not loaded yet: the mark switches to it once it arrives.
      await page.click('[role="tab"]:has-text("index.ts")');
      await fixtureCall(page, 'setFiles(["index.ts", "params.ts"])');
      await fixtureCall(page, 'setMark({ path: "reply.test.ts", line: 3 })');
      await settled(page);
      expect(await region(page)).toBe("Code difference, read only · index.ts");
      await fixtureCall(page, 'setFiles(["index.ts", "reply.test.ts", "params.ts"])');
      await settled(page);
      expect(await region(page)).toBe("Code difference, read only · reply.test.ts");
      expect(await page.locator('[data-marked="true"]').getAttribute("data-row")).toBe("2");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("the selected file tab controls the code panel, which takes keyboard focus", async () => {
    const page = await open(560);
    try {
      const tab = page.locator('[role="tab"][aria-selected="true"]');
      const panel = page.locator('[role="tabpanel"]');
      expect(await tab.getAttribute("aria-controls")).toBe(await panel.getAttribute("id"));
      expect(await panel.getAttribute("aria-labelledby")).toBe(await tab.getAttribute("id"));
      await tab.focus();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("tabpanel");
    } finally {
      await page.close();
    }
  }, 30_000);

  test("columns follow the component width and long lines scroll sideways inside the code, not the page", async () => {
    for (const [width, number, sign] of [
      [560, 36, 18],
      [342, 26, 14],
    ] as const) {
      const page = await open(width);
      try {
        const columns = await page.evaluate(() =>
          getComputedStyle(document.querySelector('[data-row="14"]')!)
            .gridTemplateColumns.split(" ")
            .map((value) => Math.round(Number.parseFloat(value))),
        );
        expect(columns.slice(0, 3)).toEqual([number, number, sign]);
        const sizes = await page.evaluate(() => {
          const body = document.querySelector(".k2b-code-diff__body")!;
          const rows = [...body.querySelectorAll<HTMLElement>(".k2b-code-diff__line")];
          return {
            overflow: body.scrollWidth - body.clientWidth,
            component: document.querySelector(".k2b-code-diff")!.getBoundingClientRect().width,
            page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            // Every row, the removed one included, reaches the end of the scrolled surface.
            rowWidths: new Set(rows.map((row) => Math.round(row.getBoundingClientRect().width))).size,
            rowWidth: Math.round(rows[0]!.getBoundingClientRect().width),
          };
        });
        expect(sizes.overflow).toBeGreaterThan(0);
        expect(Math.round(sizes.component)).toBe(width);
        expect(sizes.page).toBe(0);
        expect(sizes.rowWidths).toBe(1);
        expect(sizes.rowWidth).toBeGreaterThan(width);
        expect((await rect(page, '[data-row="14"]')).height).toBe((await rect(page, '[data-row="15"]')).height);
      } finally {
        await page.close();
      }
    }
  }, 30_000);

  test("a host height fixes the surface: code scrolls inside, and loading and failure keep its height", async () => {
    const page = await open(560);
    try {
      await page.evaluate(() => document.getElementById("app")!.style.setProperty("--k2b-code-diff-height", "300px"));
      await page.evaluate(() => (window as unknown as Fixture).setFiles(["reply.test.ts"]));
      await settled(page);
      const body = await rect(page, ".k2b-code-diff__body");
      expect(Math.round(body.height)).toBe(300);
      expect(await page.evaluate(() => document.querySelector(".k2b-code-diff__body")!.getAttribute("tabindex"))).toBe("0");
      const file = await rect(page, ".k2b-code-diff__file");
      for (const status of ["loading", "error"] as const) {
        await page.evaluate((value) => (window as unknown as Fixture).setStatus(value), status);
        await settled(page);
        const surface = await rect(page, status === "loading" ? ".k2b-code-diff__body" : ".k2b-code-diff__state");
        expect(Math.round(surface.height)).toBe(300);
        expect(surface.top).toBe(body.top);
        expect(await rect(page, ".k2b-code-diff__file")).toEqual(file);
      }
    } finally {
      await page.close();
    }
  }, 30_000);

  for (const theme of ["light", "dark"] as const) {
    test(`passes axe with a marked line (${theme})`, async () => {
      const page = await open(560, theme === "dark" ? "dark" : undefined);
      try {
        await page.evaluate(() => (window as unknown as Fixture).setMark({ path: "index.ts", line: 13 }));
        await settled(page);
        await page.addScriptTag({ content: axeSource });
        const violations = await page.evaluate(async () => {
          const result = await window.axe!.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
            resultTypes: ["violations"],
          });
          return result.violations.map(
            (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`,
          );
        });
        expect(violations).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30_000);
  }
});

// Line actions and content below a line: one tab stop over every action, focus that the host can hand back, a slot
// that moves only the rows below it, and the larger touch targets. Fixtures are fictional.
const annotatedEntry = resolve(import.meta.dir, "code-diff-annotated.fixture.ts");
const annotatedFixture = `
import { createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { CodeDiff } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

const same = (text) => ({ kind: "same", text });
const add = (text) => ({ kind: "add", text });
const del = (text) => ({ kind: "del", text });
const files = [
  { path: "code.ts", lines: [same("import { app } from '@sdk';"), same(""), same("app.schedule({ cron: '0 8 * * 1-5' }, async () => {"), del("  await draft.create();"), add("  await task.create();"), add("  await tag.set();"), same("});")] },
];
const [slotLines, setSlotLines] = createSignal([]);
window.selected = [];
window.setSlotLines = setSlotLines;
render(
  () =>
    createComponent(CodeDiff, {
      files,
      lineAction: { label: ({ line }) => "Comment on line " + line, onSelect: (location) => window.selected.push(location.line) },
      get slotLines() {
        return slotLines();
      },
      lineSlot: ({ line }) => {
        const box = document.createElement("div");
        box.className = "thread";
        box.style.height = "48px";
        box.textContent = "Thread on line " + line;
        return box;
      },
    }),
  document.getElementById("app"),
);
`;
const annotatedBuild = await Bun.build({
  entrypoints: [annotatedEntry],
  files: { [annotatedEntry]: annotatedFixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!annotatedBuild.success) throw new AggregateError(annotatedBuild.logs, "Could not bundle the annotated CodeDiff fixture.");
const annotatedScript = await annotatedBuild.outputs[0]!.text();

type Annotated = {
  selected: number[];
  setSlotLines: (lines: { path: string; line: number }[]) => void;
};

const openAnnotated = async (touch = false): Promise<Page> => {
  const context = await browser.newContext({
    viewport: { width: 640, height: 700 },
    reducedMotion: "reduce",
    ...(touch ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  const html =
    '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>CodeDiff</title>' +
    `<style>${css}</style><style>${fonts}</style></head>` +
    '<body class="k2b-ui" style="margin:0;background:var(--k2b-surface)">' +
    '<main style="padding:24px"><button id="before">Before</button><div id="app" style="width:560px"></div><button id="after">After</button></main></body></html>';
  await page.route(`${assets}page`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  await page.goto(`${assets}page`);
  await page.evaluate(() =>
    Promise.all(["400 13px 'IBM Plex Mono'", "400 15px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font))),
  );
  await page.addScriptTag({ content: annotatedScript });
  await settled(page);
  return page;
};
const focusedAction = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.actionRow ?? document.activeElement?.id ?? null);
const box = (page: Page, selector: string) =>
  page.evaluate((value) => {
    const found = document.querySelector(value)!.getBoundingClientRect();
    return { top: found.top, left: found.left, width: found.width, height: found.height };
  }, selector);

describe("CodeDiff line actions in a browser", () => {
  test("the code is one tab stop; arrow keys, Home and End move the real focus and skip removed lines", async () => {
    const page = await openAnnotated();
    try {
      await page.focus("#before");
      await page.keyboard.press("Tab");
      expect(await focusedAction(page)).toBe("0");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      // Row 3 is the removed line: it has no action.
      expect(await focusedAction(page)).toBe("4");
      await page.keyboard.press("ArrowUp");
      expect(await focusedAction(page)).toBe("2");
      await page.keyboard.press("End");
      expect(await focusedAction(page)).toBe("6");
      await page.keyboard.press("Home");
      expect(await focusedAction(page)).toBe("0");
      await page.keyboard.press("End");
      // Tab leaves the code, Shift+Tab returns to the line it left.
      await page.keyboard.press("Tab");
      expect(await focusedAction(page)).toBe("after");
      await page.keyboard.press("Shift+Tab");
      expect(await focusedAction(page)).toBe("6");
      // The focused action shows itself and its name.
      await settled(page);
      expect(await page.evaluate(() => getComputedStyle(document.activeElement!).opacity)).toBe("1");
      expect(await page.evaluate(() => document.activeElement!.getAttribute("aria-label"))).toBe("Comment on line 6");
      await page.keyboard.press("Enter");
      expect(await page.evaluate(() => (window as unknown as Annotated).selected)).toEqual([6]);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("hover shows the action in its fixed place; content below a line moves only the rows below; focus comes back", async () => {
    const page = await openAnnotated();
    try {
      const row = await box(page, '[data-row="2"]');
      const below = await box(page, '[data-row="4"]');
      const code = await box(page, '[data-row="2"] code');
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-action-row="2"]')!).opacity)).toBe("0");
      await hoverInPlace(page.locator('[data-row="2"] code'));
      await settled(page);
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-action-row="2"]')!).opacity)).toBe("1");
      expect(await box(page, '[data-row="2"]')).toEqual(row);
      expect(await box(page, '[data-row="2"] code')).toEqual(code);

      await page.evaluate(() => (window as unknown as Annotated).setSlotLines([{ path: "code.ts", line: 3 }]));
      await settled(page);
      expect(await box(page, '[data-row="2"]')).toEqual(row);
      expect(await box(page, '[data-row="2"] code')).toEqual(code);
      const slot = await box(page, ".k2b-code-diff__slot");
      expect(Math.round(slot.top)).toBe(Math.round(row.top + row.height));
      expect(Math.round((await box(page, '[data-row="4"]')).top)).toBe(Math.round(below.top + slot.height));
      expect(await page.locator('[data-row="2"] .k2b-code-diff__noted').count()).toBe(1);

      // The host hands the focus back after closing its content: each action names its line.
      await page.evaluate(() => (window as unknown as Annotated).setSlotLines([]));
      await page.evaluate(() => document.querySelector<HTMLElement>('[data-action-line="3"]')!.focus());
      await page.waitForFunction(() => (document.activeElement as HTMLElement | null)?.dataset.actionRow === "2");
      expect(await box(page, '[data-row="4"]')).toEqual(below);
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("on touch, lines are 30 px high and the action is 32 × 28 px, always visible and quiet", async () => {
    const page = await openAnnotated(true);
    try {
      expect(Math.round((await box(page, '[data-row="2"]')).height)).toBe(30);
      const action = await box(page, '[data-action-row="2"]');
      expect([Math.round(action.width), Math.round(action.height)]).toEqual([32, 28]);
      // Visible without hover, but a grey sign without a fill, so it never reads as a column of buttons.
      const look = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('[data-action-row="2"]')!);
        return { opacity: Number(style.opacity), fill: style.backgroundColor };
      });
      expect(look.opacity).toBeGreaterThanOrEqual(0.5);
      expect(look.fill).toBe("rgba(0, 0, 0, 0)");
    } finally {
      await page.context().close();
    }
  }, 30_000);

  test("passes axe with actions, a marked line and content below it", async () => {
    const page = await openAnnotated();
    try {
      await page.evaluate(() => (window as unknown as Annotated).setSlotLines([{ path: "code.ts", line: 5 }]));
      await settled(page);
      await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => {
        const result = await window.axe!.run(document, {
          runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
          resultTypes: ["violations"],
        });
        return result.violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`);
      });
      expect(violations).toEqual([]);
    } finally {
      await page.context().close();
    }
  }, 30_000);
});
