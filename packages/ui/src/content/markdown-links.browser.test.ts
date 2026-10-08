import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../test/browser";
import { renderSafeMarkdown } from "./MarkdownView";
import { renderMarkdownLink } from "./markdown-links";

// Hover and focus must never move text: the shipped stylesheet decides that,
// so a real engine measures every line box before and after each state.
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const longName = "2026-10-07_Markenrichtlinien_Kolb-Antik_Druckfassung_mit_Beschnitt_und_Schnittmarken_final.pdf";
const prose = renderSafeMarkdown(
  [
    "Die Fassung liegt als [Markenrichtlinien-2026.pdf](/files/Markenrichtlinien-2026.pdf) vor, die Vorlage auf",
    "[Affinity Designer](https://affinity.serif.com) und in [brand-guidelines.afdesign](/files/brand-guidelines.afdesign).",
    "Hintergrund steht in [Kickoff](/app/notes/Kick01), Fragen an design@kolb-antik.de, Druckdaten:",
    `[${longName}](/files/${longName}), siehe [Akzentfarbe](#akzentfarbe).`,
  ].join(" "),
  { locale: "de" },
);
const extra =
  `<p>Offen ist ${renderMarkdownLink({ href: "/app/tasks/1", html: "Logo-Freigabe einholen", reference: { kind: "task" }, locale: "de" })} und ` +
  `${renderMarkdownLink({ href: "/n/2#akzent", html: "Akzentfarbe", reference: { kind: "heading", document: "Farbsystem" }, locale: "de" })}.</p>` +
  `<p>${renderMarkdownLink({ href: "/f/3", html: "logo-varianten.png", reference: { kind: "file", size: "860 kB" }, standalone: true, locale: "de" })}</p>`;

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 480, height: 900 } });
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>.k2b-ui * { transition: none !important; }</style></head>` +
      `<body class="k2b-ui"><button id="start">Start</button>` +
      `<main id="md" class="k2b-content-markdown" style="width:420px;padding:0 24px;font-size:16px;line-height:1.75">${prose}${extra}</main></body></html>`,
  );
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

/** Every line box of every text node and link, rounded to a hundredth of a pixel. */
const geometry = () =>
  page.evaluate(() => {
    const round = (rect: DOMRect) => [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 100) / 100).join(",");
    const root = document.getElementById("md")!;
    const boxes: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) boxes.push(`t:${round(rect)}`);
    }
    for (const link of root.querySelectorAll("a")) for (const rect of link.getClientRects()) boxes.push(`a:${round(rect)}`);
    return boxes;
  });

const links = () => page.$$eval("#md a", (anchors) => anchors.map((_, index) => index));

describe(`Markdown links in ${browserName}`, () => {
  test("hovering any link changes only paint, never a line box", async () => {
    const before = await geometry();
    for (const index of await links()) {
      const selector = `#md a >> nth=${index}`;
      const restPaint = await page
        .locator(selector)
        .evaluate((a) => [getComputedStyle(a).backgroundColor, getComputedStyle(a).textDecorationColor]);
      await page.locator(selector).hover();
      const hovered = await page
        .locator(selector)
        .evaluate((a) => [getComputedStyle(a).backgroundColor, getComputedStyle(a).textDecorationColor]);
      // The state is real: a pill darkens its fill, a text link strengthens its underline.
      expect(hovered).not.toEqual(restPaint);
      expect(await geometry()).toEqual(before);
    }
    await page.mouse.move(0, 0);
  }, 30_000);

  test("keyboard focus draws an outline on every link without moving text", async () => {
    const before = await geometry();
    for (const index of await links()) {
      await page.focus("#start");
      await page.keyboard.press("Shift");
      const outline = await page.locator(`#md a >> nth=${index}`).evaluate((a) => {
        a.focus();
        const style = getComputedStyle(a);
        return [a.matches(":focus-visible"), style.outlineStyle, style.fontWeight];
      });
      expect(outline.slice(0, 2)).toEqual([true, "solid"]);
      expect(await geometry()).toEqual(before);
    }
  }, 30_000);

  test("a long file name wraps inside its pill, which repeats its padding on every line", async () => {
    const result = await page.evaluate((name) => {
      const root = document.getElementById("md")!;
      const pill = [...root.querySelectorAll<HTMLAnchorElement>("a.k2b-reference")].find((a) => a.textContent === name)!;
      const style = getComputedStyle(pill);
      const fragments = [...pill.getClientRects()];
      const text = document.createRange();
      text.selectNodeContents(pill.lastChild!);
      const lines = [...text.getClientRects()];
      const content = root.getBoundingClientRect();
      return {
        decoration: style.boxDecorationBreak || style.getPropertyValue("-webkit-box-decoration-break"),
        fragments: fragments.length,
        inside: fragments.every((rect) => rect.left >= content.left - 0.5 && rect.right <= content.right + 0.5),
        // Each fragment starts with the pill's padding before its text.
        padded: fragments.every((fragment) =>
          lines.some((line) => Math.abs(line.top - fragment.top) < fragment.height && line.left - fragment.left >= 5),
        ),
      };
    }, longName);
    expect(result).toEqual({ decoration: "clone", fragments: result.fragments, inside: true, padded: true });
    expect(result.fragments).toBeGreaterThanOrEqual(2);
  });

  test("pills keep prose ink and a neutral fill; only the icon carries the type colour", async () => {
    const colours = await page.evaluate(() => {
      const root = document.getElementById("md")!;
      const paragraph = getComputedStyle(root.querySelector("p")!).color;
      const pills = [...root.querySelectorAll<HTMLElement>("a.k2b-reference")];
      const icon = (type: string) => getComputedStyle(root.querySelector(`a[data-reference="${type}"] .k2b-reference__icon`)!).color;
      return {
        ink: pills.every((pill) => getComputedStyle(pill).color === paragraph),
        fills: new Set(pills.map((pill) => getComputedStyle(pill).backgroundColor)).size,
        weights: new Set(pills.map((pill) => getComputedStyle(pill).fontWeight)).size,
        icons: ["pdf", "design", "page", "task", "heading", "image"].map(icon),
        web: getComputedStyle(root.querySelector('a[data-link="web"]')!).color === paragraph,
      };
    });
    expect(colours).toEqual({
      ink: true,
      fills: 1,
      weights: 1,
      icons: ["rgb(220, 38, 38)", "rgb(194, 65, 12)", "rgb(113, 113, 122)", "rgb(4, 120, 87)", "rgb(113, 113, 122)", "rgb(124, 58, 237)"],
      web: true,
    });
  });
});
