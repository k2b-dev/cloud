import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type axeCore from "axe-core";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

// Fold and mark geometry, wrapping at the component's own width, focus after revealing rows, and contrast are results
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
window.setMark = setMark;
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
  changes: string[];
};
const fixtureCall = (page: Page, call: string) => page.evaluate(`window.${call}`);

/** The component in a column of `width` px, in a viewport short enough that a far line must scroll. */
const open = async (width: number, theme?: "dark"): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: Math.max(width + 48, 390), height: 700 }, reducedMotion: "reduce" });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  const html =
    '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>CodeDiff</title>' +
    `<style>${css}</style><style>${fonts}</style></head>` +
    `<body class="k2b-ui${theme === "dark" ? " k2b-dark" : ""}" style="margin:0;background:var(--k2b-surface)">` +
    `<main style="padding:24px"><div id="app" style="width:${width}px"></div></main></body></html>`;
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

  test("columns follow the component width and long lines wrap instead of scrolling", async () => {
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
        const overflow = await page.evaluate(() => {
          const body = document.querySelector(".k2b-code-diff__body")!;
          return body.scrollWidth - body.clientWidth;
        });
        expect(overflow).toBe(0);
        expect((await rect(page, '[data-row="14"]')).height).toBeGreaterThan((await rect(page, '[data-row="15"]')).height);
      } finally {
        await page.close();
      }
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
