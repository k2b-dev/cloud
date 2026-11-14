import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { meterType } from "../../../../scripts/fixtures/type-meter";
import { launchBrowser, settled } from "../../test/browser";
import type {} from "../../test/discussion-thread.browser-harness";

const ui = resolve(import.meta.dir, "../..");
const assets = "http://k2b-ui.test/";
const fonts = readFileSync(resolve(ui, "dist/plex.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);
const icons = readFileSync(resolve(ui, "dist/tabler.css"), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`);

setDefaultTimeout(30_000);
let browser: Browser;
let bundle: string;
let css: string;
beforeAll(async () => {
  const { transformAsync } = await import("@babel/core");
  const typescript = (await import("@babel/preset-typescript")).default;
  const solid = (await import("babel-preset-solid")).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "../../test/discussion-thread.browser-harness.tsx")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "discussion-thread-dom",
        setup(builder) {
          // The harness runs against the shipped browser build, so only the harness itself goes through Babel.
          builder.onResolve({ filter: /\/src\/index$/ }, () => ({ path: resolve(ui, "dist/browser/index.js") }));
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            if (!result?.code) throw new Error(`Could not transform ${path}`);
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Discussion thread harness failed");
  bundle = await build.outputs[0]!.text();
  css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number) => {
  const page = await browser.newPage({ viewport: { width, height: width === 1440 ? 900 : 780 } });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({
      path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)),
      headers: { "access-control-allow-origin": "*" },
    }),
  );
  await page.setContent(
    `<!doctype html><html lang="en"><head><style>${css}</style><style>${fonts}</style><style>${icons}</style>
      <style>body{margin:0;background:var(--k2b-surface-muted)} p{margin:0}</style></head>
      <body class="k2b-ui" data-theme="light"><div id="root"></div></body></html>`,
  );
  await page.addScriptTag({ content: bundle });
  await page.waitForSelector(".k2b-discussion-thread");
  await page.evaluate(() => document.fonts.ready);
  await settled(page);
  return page;
};
const box = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((node) => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return { x, y, width, height };
    });
const lefts = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().left));

for (const width of [1440, 390]) {
  describe(`Discussion.Thread at ${width}`, () => {
    test("every entry, avatar, and the reply field stand on one edge 11 px from the line, 8 px apart, without indent", async () => {
      const page = await open(width);
      try {
        const thread = await box(page, "#many .k2b-discussion-thread");
        const avatars = await lefts(page, "#many .k2b-discussion__avatar");
        expect(new Set(avatars).size).toBe(1);
        // The 1 px line, then 11 px to the avatars.
        expect(avatars[0]).toBe(thread.x + 12);
        expect((await box(page, "#many .k2b-discussion-thread__reply")).x).toBe(avatars[0]!);
        const rows = await page
          .locator("#many .k2b-discussion__item")
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map((rect) => [rect.top, rect.bottom]));
        for (let index = 1; index < rows.length; index++) expect(rows[index]![0]! - rows[index - 1]![1]!).toBe(8);
        // No surface: the thread is transparent, only its 1 px line is drawn.
        const paint = await page.locator("#many .k2b-discussion-thread").evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            background: style.backgroundColor,
            width: style.borderLeftWidth,
            colour: style.borderLeftColor,
            radius: style.borderRadius,
          };
        });
        expect(paint).toEqual({ background: "rgba(0, 0, 0, 0)", width: "1px", colour: "rgb(200, 200, 208)", radius: "0px" });
        // An action such as "Delete" keeps its header line at 19 px.
        const headers = await page
          .locator("#many .k2b-discussion__entry > header")
          .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
        expect(headers).toEqual([19, 19, 19]);
      } finally {
        await page.close();
      }
    });

    test("focus opens the writing field in place: the line turns 2 px in the focus colour and no text moves", async () => {
      const page = await open(width);
      try {
        const entryText = await box(page, "#one .k2b-discussion__content");
        const reply = await box(page, "#one .k2b-discussion-thread__reply");
        await page.locator("#one .k2b-discussion-thread__reply").focus();
        await settled(page);
        const field = page.locator("#one .k2b-discussion-thread__field");
        expect(await field.evaluate((node) => node === document.activeElement)).toBe(true);
        expect((await box(page, "#one .k2b-discussion-thread__field")).x).toBe(reply.x);
        expect(await box(page, "#one .k2b-discussion__content")).toEqual(entryText);
        expect(
          await page
            .locator("#one .k2b-discussion-thread")
            .evaluate((node) => [getComputedStyle(node).borderLeftWidth, getComputedStyle(node).borderLeftColor]),
        ).toEqual(["2px", "rgb(29, 78, 216)"]);
        // An empty comment cannot be posted.
        expect(await page.locator("#one .k2b-discussion-thread__actions button[type=submit]").isDisabled()).toBe(true);
        expect(await page.locator("#one .k2b-discussion-thread__status > :not([role=alert])").textContent()).toBe(
          "Visible with your decision",
        );
        await page.keyboard.press("Escape");
        await settled(page);
        expect(await page.locator("#one .k2b-discussion-thread__field").count()).toBe(0);
        expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-discussion-thread"))).toBe(true);
        // Tab from the thread reaches the reply field without opening it; Enter opens it.
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-discussion-thread__reply"))).toBe(true);
        expect(await page.locator("#one .k2b-discussion-thread__field").count()).toBe(0);
        await page.keyboard.press("Enter");
        await settled(page);
        expect(await page.locator("#one .k2b-discussion-thread__field").count()).toBe(1);
        // Written text survives Escape; an empty field closes when the focus moves on.
        await page.keyboard.type("Keep me");
        await page.keyboard.press("Escape");
        expect(await page.locator("#one .k2b-discussion-thread__field").inputValue()).toBe("Keep me");
        await page.locator("#one .k2b-discussion-thread__field").fill("");
        for (let step = 0; step < 3; step++) await page.keyboard.press("Tab");
        await settled(page);
        expect(await page.locator("#one .k2b-discussion-thread__field").count()).toBe(0);
      } finally {
        await page.close();
      }
    });

    test("the first character opens the writing field and stays in it", async () => {
      const page = await open(width);
      try {
        await page.locator("#many .k2b-discussion-thread__reply").evaluate((node) => {
          const input = node as HTMLInputElement;
          input.value = "O";
          input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        });
        await settled(page);
        expect(await page.locator("#many .k2b-discussion-thread__field").inputValue()).toBe("O");
      } finally {
        await page.close();
      }
    });

    test("a comment of several lines posts without a jump: the field held one line more than its text", async () => {
      const page = await open(width);
      try {
        const text = "Every unread mail gets a task, not only a callback request, and the folder name must match the old one exactly.";
        await page.locator("#new .k2b-discussion-thread__field").fill(text);
        await settled(page);
        const thread = await box(page, "#new .k2b-discussion-thread");
        await page.locator("#new .k2b-discussion-thread__field").press("Control+Enter");
        await settled(page);
        expect(await page.locator("#new .k2b-discussion__item").count()).toBe(1);
        expect((await box(page, "#new .k2b-discussion__content")).height).toBeGreaterThan(19);
        expect(await box(page, "#new .k2b-discussion-thread")).toEqual(thread);
      } finally {
        await page.close();
      }
    });

    for (const id of ["one", "new"]) {
      test(`${id}: posting a short comment keeps the thread's height and moves nothing below it (0 px)`, async () => {
        const page = await open(width);
        try {
          if (id === "one") await page.locator("#one .k2b-discussion-thread__reply").focus();
          await settled(page);
          await page.locator(`#${id} .k2b-discussion-thread__field`).fill("Please also cover read mails.");
          await settled(page);
          const thread = await box(page, `#${id} .k2b-discussion-thread`);
          const below = await box(page, `#after-${id}`);
          await page.locator(`#${id} .k2b-discussion-thread__actions button[type=submit]`).click();
          await settled(page);
          expect(await page.locator(`#${id} .k2b-discussion__item`).last().textContent()).toContain("Please also cover read mails.");
          expect(await page.locator(`#${id} .k2b-discussion-thread__field`).count()).toBe(0);
          expect(await box(page, `#${id} .k2b-discussion-thread`)).toEqual(thread);
          expect(await box(page, `#after-${id}`)).toEqual(below);
        } finally {
          await page.close();
        }
      });
    }

    test("a failed post keeps the text, names the cause in the status line, and offers Retry without a jump", async () => {
      const page = await open(width);
      try {
        await page.evaluate(() => {
          window.__failNext = true;
        });
        await page.locator("#new .k2b-discussion-thread__field").fill("Check the folder name.");
        await settled(page);
        const thread = await box(page, "#new .k2b-discussion-thread");
        await page.locator("#new .k2b-discussion-thread__actions button[type=submit]").click();
        await settled(page);
        expect(await page.locator("#new .k2b-discussion-thread__field").inputValue()).toBe("Check the folder name.");
        expect(await page.locator("#new .k2b-discussion-thread__status [role=alert]").textContent()).toBe("The comment was not saved.");
        // The keyboard stays in the field to retry.
        expect(await page.evaluate(() => document.activeElement?.classList.contains("k2b-discussion-thread__field"))).toBe(true);
        expect(await page.locator("#new .k2b-discussion-thread__actions button[type=submit]").textContent()).toBe("Retry");
        expect(await box(page, "#new .k2b-discussion-thread")).toEqual(thread);
        await page.locator("#new .k2b-discussion-thread__actions button[type=submit]").click();
        await settled(page);
        expect(await page.locator("#new .k2b-discussion__item").count()).toBe(1);
      } finally {
        await page.close();
      }
    });

    test("type holds the rule: name 13/600, text 13/400, role and time 12/400, avatars on one axis", async () => {
      const page = await open(width);
      try {
        const type = await meterType(page, "#many .k2b-discussion-thread", { signs: ".k2b-avatar" });
        expect(type.styles).toEqual(["12/400", "13/400", "13/600"]);
        expect(type.offSizes).toEqual([]);
        expect(type.axes).toHaveLength(1);
      } finally {
        await page.close();
      }
    });
  });
}

// Evidence for reviews: K2B_DISCUSSION_SCREENSHOTS=<dir> writes the thread, the replies, and writing at both widths.
const shots = process.env.K2B_DISCUSSION_SCREENSHOTS;
test.if(Boolean(shots))("screenshots of the thread states", async () => {
  mkdirSync(shots!, { recursive: true });
  for (const width of [1440, 390]) {
    const page = await open(width);
    try {
      await page.locator("#one .k2b-discussion-thread__reply").focus();
      await page.locator("#one .k2b-discussion-thread__field").fill("Please also cover read mails.");
      await settled(page);
      await page.screenshot({ path: `${shots}/discussion-thread-${width}.png` });
    } finally {
      await page.close();
    }
  }
});
