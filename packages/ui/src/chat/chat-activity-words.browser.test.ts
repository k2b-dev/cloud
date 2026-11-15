import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { hoverInPlace, launchBrowser, settled } from "../../test/browser";

// A running activity changes its word with time (Feinschliff v3, section 1). Whether only one word ever stands in its
// place and whether the time beside it keeps its box are questions of a real layout engine. The page clock is frozen,
// so every change happens at an exact phase time.
const ui = resolve(import.meta.dir, "../..");
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
const assets = "http://k2b-ui.test/";
const fonts = ["plex.css", "tabler.css"]
  .map((file) => readFileSync(resolve(ui, "dist", file), "utf8").replace(/url\((["']?)(?:\.\/)?(?!data:|https?:)/g, `url($1${assets}`))
  .join("\n");
const TEST_TIMEOUT = 30_000;
const FIRST = "Denkt nach";
// The longest approved word must fit a phone line too.
const WORDS = ["Grübelt", "Hält Rücksprache mit dem Schnurrbart", "Wägt ab", "Spitzt den Bleistift", "Sichtet", "Putzt die Brille"];
const entry = resolve(import.meta.dir, "chat-activity-words.fixture.ts");
const fixture = `
import { createComponent, render } from "solid-js/web";
import { Chat } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
render(() => createComponent(Chat.Activity, {
  tone: "ai",
  busy: true,
  icon: "ti ti-sparkles",
  get label() {
    return createComponent(Chat.Activity.Words, { first: ${JSON.stringify(FIRST)}, words: ${JSON.stringify(WORDS)}, elapsedMs: 0, announce: "Gustav denkt nach" });
  },
  trailing: "12 s",
}), document.getElementById("app"));
`;
const build = await Bun.build({
  entrypoints: [entry],
  files: { [entry]: fixture },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
});
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the activity words fixture.");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const open = async (width: number, reducedMotion: "reduce" | "no-preference" = "no-preference"): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width, height: 400 }, reducedMotion });
  await page.clock.install({ time: new Date("2026-11-15T10:00:00Z") });
  await page.route(`${assets}**`, (route) =>
    route.fulfill({ path: resolve(ui, "dist", new URL(route.request().url()).pathname.slice(1)) }),
  );
  await page.setContent(`<!doctype html><html lang="de"><head><style>${css}</style><style>${fonts}</style>
    <style>#app{max-width:764px;margin:40px auto;padding:0 16px}</style></head>
    <body class="k2b-ui" data-k2b-primary="ai" style="margin:0;background:var(--k2b-surface)"><div id="app"></div></body></html>`);
  await page.evaluate(async () => {
    await Promise.all(
      ["400 13px 'IBM Plex Sans'", "400 14px 'IBM Plex Sans'", "16px tabler-icons"].map((font) => document.fonts.load(font)),
    );
  });
  await page.addScriptTag({ content: script });
  await page.locator(".k2b-chat-activity__word").waitFor();
  await settled(page);
  return page;
};

/** Every word element in the place, with its phase and opacity, and the box of the time beside it. */
const sample = (page: Page) =>
  page.evaluate(() => {
    // Every word in the place that the page shows: the changing word and the resting first word, if visible.
    const words = [...document.querySelectorAll<HTMLElement>(".k2b-chat-activity__word, .k2b-chat-activity__word-rest")]
      .filter((node) => getComputedStyle(node).display !== "none")
      .map((node) => ({
        text: node.textContent,
        phase: node.dataset.phase,
        opacity: Number(getComputedStyle(node).opacity),
      }));
    const time = document.querySelector(".k2b-chat-activity__trailing")!.getBoundingClientRect();
    const row = document.querySelector(".k2b-chat-activity__row")!.getBoundingClientRect();
    return { words, time: [time.left, time.top, time.width, time.height], row: [row.left, row.top, row.width, row.height] };
  });

describe("Chat.Activity.Words in the browser", () => {
  for (const width of [1440, 390]) {
    test(
      `at ${width} px one word at a time, and the time beside it keeps its box over ten changes`,
      async () => {
        const page = await open(width);
        try {
          const start = await sample(page);
          expect(start.words.map((word) => word.text)).toEqual([FIRST]);
          await page.clock.runFor(2_900);
          expect((await sample(page)).words.map((word) => word.text)).toEqual([FIRST]);
          const seen: string[] = [];
          for (let change = 0; change < 10; change++) {
            // Run to the next change, then through the fade out and into the fade in, sampling each step.
            await page.clock.runFor(change === 0 ? 110 : 2_400 - 290);
            let step = 0;
            for (const delta of [0, 60, 70, 70, 90]) {
              if (delta) await page.clock.runFor(delta);
              step += delta;
              const now = await sample(page);
              // Never two words in the place: one element, and it is the only visible text there.
              expect(now.words, `change ${change}, +${step} ms`).toHaveLength(1);
              expect(now.time, `change ${change}, +${step} ms`).toEqual(start.time);
              expect(now.row, `change ${change}, +${step} ms`).toEqual(start.row);
            }
            seen.push((await sample(page)).words[0]!.text ?? "");
          }
          // The words follow the host's order, round after round.
          expect(seen).toEqual(Array.from({ length: 10 }, (_, index) => WORDS[index % WORDS.length]!));
        } finally {
          await page.close();
        }
      },
      TEST_TIMEOUT * 2,
    );
  }

  test(
    "the old word has faded out before the next one fades in",
    async () => {
      const page = await open(1440);
      try {
        await page.clock.runFor(3_001);
        const out = await sample(page);
        expect(out.words).toEqual([{ text: FIRST, phase: "out", opacity: expect.any(Number) }]);
        await page.clock.runFor(125);
        const next = await sample(page);
        expect(next.words.map((word) => [word.text, word.phase])).toEqual([[WORDS[0], "in"]]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "with reduced motion the first word stands from the first frame and only the seconds count on",
    async () => {
      const page = await open(1440, "reduce");
      try {
        expect((await sample(page)).words.map((word) => word.text)).toEqual([FIRST]);
        await page.clock.runFor(30_000);
        expect((await sample(page)).words.map((word) => word.text)).toEqual([FIRST]);
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "a pointer on the row holds the word, and screen readers hear one stable sentence",
    async () => {
      const page = await open(1440);
      try {
        await page.clock.runFor(3_500);
        const held = (await sample(page)).words[0]!.text;
        await hoverInPlace(page.locator(".k2b-chat-activity__row"));
        await page.clock.runFor(10_000);
        expect((await sample(page)).words.map((word) => word.text)).toEqual([held]);
        expect(await page.locator('[role="status"]').allTextContents()).toEqual(["Gustav denkt nach"]);
        expect(await page.locator(".k2b-chat-activity__words").getAttribute("aria-hidden")).toBe("true");
      } finally {
        await page.close();
      }
    },
    TEST_TIMEOUT,
  );
});
