import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// `celebrate` draws the success check once when it appears: the ring closes, the check follows, the mark springs up,
// all within a second. It sits where the glyph sat, at the glyph's size and colour, and reduced motion, from the
// operating system or from `data-k2b-motion="reduced"`, shows the finished check at once.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const fontCss = resolve(ui, "node_modules/@tabler/icons-webfont/dist/tabler-icons.min.css");
const ORIGIN = "http://success-check.test";
const TEST_TIMEOUT = 30_000;
const STILL = "matrix(1, 0, 0, 1, 0, 0)";
const entry = resolve(import.meta.dir, "success-check.fixture.ts");
const fixture = `
import { createComponent } from "solid-js/web";
import { dialogCore, PanelDialog, panelDialogOptions, prompts, toast } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};

window.show = {
  toast: (celebrate) => void toast.success("Invoice RE-2026-0142 issued", { duration: 0, celebrate }),
  prompt: (celebrate) => void prompts.success("The invoice is ready to send.", { title: "Invoice issued", celebrate }),
  panel: (celebrate) => void dialogCore.open((close) => createComponent(PanelDialog, { tone: "success", celebrate, get children() {
    return createComponent(PanelDialog.Header, { title: "Customer K-1042 created", subtitle: "Mueller Antik GmbH", close });
  } }), panelDialogOptions),
};
`;
const build = await Bun.build({ entrypoints: [entry], files: { [entry]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the success check fixture.");
const script = await build.outputs[0]!.text();

type Place = "toast" | "prompt" | "panel";
const glyph: Record<Place, string> = {
  toast: ".k2b-toast__icon > :is(i, svg)",
  prompt: "dialog[open] .k2b-dialog__header > :is(i, svg)",
  panel: "dialog[open] .k2b-panel-dialog__icon > :is(i, svg)",
};
const places = Object.keys(glyph) as Place[];

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (place: Place, celebrate: boolean, motion: "full" | "host" | "os" = "full"): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  if (motion === "os") await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route(`${ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") {
      const host = motion === "host" ? ' data-k2b-motion="reduced"' : "";
      return route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"${host}><head><link rel="stylesheet" href="/font/tabler-icons.min.css"><style>${css}</style></head>
          <body class="k2b-ui" style="margin:0"></body></html>`,
      });
    }
    return route.fulfill({ path: resolve(dirname(fontCss), path.replace(/^\/font\//, "")) });
  });
  await page.goto(`${ORIGIN}/`);
  await page.evaluate(() => document.fonts.load('1em "tabler-icons"'));
  await page.addScriptTag({ content: script });
  await page.evaluate(
    ([name, value]) => (window as unknown as { show: Record<string, (celebrate: boolean) => void> }).show[name!]!(value),
    [place, celebrate] as const,
  );
  await page.locator(glyph[place]).waitFor();
  return page;
};

/** Box and colour of the glyph and of its container, with every animation of the check at `time` (ms) or finished. */
const state = (page: Page, place: Place, time?: number) =>
  page.locator(glyph[place]).evaluate((node, at) => {
    const animations = node.getAnimations({ subtree: true }).filter((item) => item.timeline === document.timeline);
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = at ?? Number(animation.effect!.getComputedTiming().endTime);
    }
    const rect = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const offset = (selector: string) => {
      const part = node.querySelector(selector);
      return part ? getComputedStyle(part).strokeDashoffset : null;
    };
    return {
      box: rect(node),
      container: rect(node.parentElement!),
      fontSize: getComputedStyle(node).fontSize,
      color: getComputedStyle(node).color,
      // A filled keyframe without a transform computes to the identity matrix: still, at its own size.
      transform: getComputedStyle(node).transform.replace("none", "matrix(1, 0, 0, 1, 0, 0)"),
      ring: offset(".k2b-success-check__ring"),
      mark: offset(".k2b-success-check__mark"),
      ends: animations.map((animation) => Number(animation.effect!.getComputedTiming().endTime)),
    };
  }, time);

describe("@k2b/ui success check", () => {
  for (const place of places) {
    test(
      `${place}: draws the ring, then the check, then springs, within a second`,
      async () => {
        const page = await open(place, true);
        try {
          const start = await state(page, place, 0);
          expect(start.ends).toHaveLength(3);
          expect(Math.max(...start.ends)).toBeGreaterThan(500);
          expect(Math.max(...start.ends)).toBeLessThan(1000);
          // The first frame shows nothing yet; the round caps stay hidden too.
          expect(start).toMatchObject({ ring: "1.05px", mark: "1.05px", transform: STILL });
          // Half way the ring is drawn more than the check.
          const middle = await state(page, place, 300);
          expect(Number.parseFloat(middle.ring!)).toBeLessThan(Number.parseFloat(middle.mark!));
          expect(await state(page, place)).toMatchObject({ ring: "0px", mark: "0px", transform: STILL });

          // It draws once: hovering the finished check starts nothing.
          await page.locator(glyph[place]).hover({ force: true });
          expect(
            await page.locator(glyph[place]).evaluate(
              (node) =>
                node
                  .getAnimations({ subtree: true })
                  .filter((item) => item.timeline === document.timeline)
                  .filter((item) => item.playState === "running").length,
            ),
          ).toBe(0);
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT,
    );

    test(
      `${place}: the check takes the glyph's place, size, and colour`,
      async () => {
        const plain = await open(place, false);
        const drawn = await open(place, true);
        try {
          const before = await state(plain, place);
          const after = await state(drawn, place);
          expect(after.container).toEqual(before.container);
          expect(after.color).toBe(before.color);
          expect(after.box.width).toBe(Number.parseFloat(before.fontSize));
          for (const key of ["x", "y", "width", "height"] as const)
            expect(Math.abs(after.box[key] - before.box[key])).toBeLessThanOrEqual(1);
        } finally {
          await plain.close();
          await drawn.close();
        }
      },
      TEST_TIMEOUT,
    );
  }

  for (const motion of ["host", "os"] as const) {
    test(
      `reduced motion (${motion}) shows the finished check at once`,
      async () => {
        for (const place of places) {
          const page = await open(place, true, motion);
          try {
            const now = await page.locator(glyph[place]).evaluate((node) => ({
              running: node
                .getAnimations({ subtree: true })
                .filter((item) => item.timeline === document.timeline)
                .filter((item) => item.playState === "running").length,
              ring: getComputedStyle(node.querySelector(".k2b-success-check__ring")!).strokeDashoffset,
              mark: getComputedStyle(node.querySelector(".k2b-success-check__mark")!).strokeDashoffset,
              transform: getComputedStyle(node).transform.replace("none", "matrix(1, 0, 0, 1, 0, 0)"),
            }));
            expect(now).toEqual({ running: 0, ring: "0px", mark: "0px", transform: STILL });
          } finally {
            await page.close();
          }
        }
      },
      TEST_TIMEOUT,
    );
  }
});
