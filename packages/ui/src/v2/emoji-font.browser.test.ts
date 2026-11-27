import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, launchHookMs, pageErrors } from "../../test/browser";

// An emoji in text draws as the system's colour emoji, not as a plain glyph of a later system font. The font stacks of
// v2 (`--k2-font`, `--k2-font-mono`) and of v1 (`--k2b-font-sans`, `--k2b-font-mono` in fonts.css) name `k2-emoji`, the
// system's colour emoji limited to the pictographic blocks, right after the text font. A text symbol the text font
// lacks (a check mark, a star, an arrow, ⌘) keeps the glyph and the width it had without `k2-emoji`.

const v2 = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const v1 = readFileSync(resolve(import.meta.dir, "../fonts/plex.css"), "utf8").replace(/^@import[^;]*;$/gm, "");
const stacks = {
  v2: "var(--k2-font)",
  "v2 mono": "var(--k2-font-mono)",
  v1: "var(--k2b-font-sans)",
  "v1 mono": "var(--k2b-font-mono)",
};
/** The same stacks as they were before `k2-emoji`: the width a text symbol must keep. */
const before = {
  v2: '"IBM Plex Sans", system-ui, sans-serif',
  "v2 mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  v1: '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif',
  "v1 mono": '"IBM Plex Mono", ui-monospace, monospace',
};
const emoji = ["😀", "📦", "👍"];
const symbols = ["✓", "★", "→", "⌘"];

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

/** For each stack and sign: the width of the sign in a 20 px span, and whether it draws in more than its text colour. */
const measure = async (page: Page, signs: string[]) => {
  const spans = Object.entries({ ...stacks, ...Object.fromEntries(Object.entries(before).map(([key, stack]) => [`${key} before`, stack])) })
    .flatMap(([name, stack]) =>
      signs.map(
        (sign) => `<span data-s="${name}" style="font: 400 20px ${stack.replaceAll('"', "&quot;")}; color: #ff0000">${sign}</span>`,
      ),
    )
    .join("");
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${v2}</style><style>${v1}</style></head>` +
      `<body><div class="k2-ui"><div class="k2b-ui">${spans}</div></div></body></html>`,
  );
  return page.evaluate(async () => {
    await document.fonts.ready;
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 40;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    const out: Record<string, { width: number; colour: boolean }[]> = {};
    for (const span of document.querySelectorAll<HTMLElement>("[data-s]")) {
      context.clearRect(0, 0, 40, 40);
      context.font = getComputedStyle(span).font;
      context.fillStyle = "#ff0000";
      context.textBaseline = "top";
      context.fillText(span.textContent!, 4, 4);
      const pixels = context.getImageData(0, 0, 40, 40).data;
      // a text glyph is drawn in its fill colour only (red, with any alpha); a colour emoji has other hues
      let other = 0;
      for (let at = 0; at < pixels.length; at += 4) if (pixels[at + 3]! > 64 && (pixels[at + 1]! > 60 || pixels[at + 2]! > 60)) other += 1;
      (out[span.dataset.s!] ??= []).push({ width: Math.round(span.getBoundingClientRect().width * 10) / 10, colour: other > 8 });
    }
    return out;
  });
};

test("an emoji in v2 and v1 text, sans and mono, draws as the colour emoji", async () => {
  const page = await browser.newPage();
  const errors = pageErrors(page);
  try {
    const found = await measure(page, emoji);
    for (const name of Object.keys(stacks))
      expect({ name, colour: found[name]!.map((sign) => sign.colour) }).toEqual({ name, colour: emoji.map(() => true) });
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});

test("a text symbol the text font lacks keeps its text glyph and width", async () => {
  const page = await browser.newPage();
  try {
    const found = await measure(page, symbols);
    for (const name of Object.keys(stacks) as (keyof typeof stacks)[])
      expect({ name, signs: found[name] }).toEqual({ name, signs: found[`${name} before`] });
    for (const name of Object.keys(stacks))
      expect({ name, colour: found[name]!.map((sign) => sign.colour) }).toEqual({ name, colour: symbols.map(() => false) });
  } finally {
    await page.close();
  }
});
