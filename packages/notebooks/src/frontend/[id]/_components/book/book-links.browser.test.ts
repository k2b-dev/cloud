import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser } from "../../../../../../ui/test/browser";
import { renderNotebookBook } from "../../../../lib/book-renderer";

// Book links the app's stylesheet before Cloud's global one, so the shipped
// cascade decides whether Book's own link rules still win anywhere.
let browser: Browser;
let page: Page;
beforeAll(async () => {
  const stylesheets = [resolve(import.meta.dir, "../../../../styles/app.css"), resolve(import.meta.dir, "../../../../../../../styles.css")];
  const outputs = await Promise.all(
    stylesheets.map(async (entry) => {
      const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
      if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}.`);
      return build.outputs[0]!.text();
    }),
  );
  const css = ["@layer properties, theme, base, components, utilities;", ...outputs].join("\n");
  const { html } = renderNotebookBook({
    markdown: [
      ":::toc",
      ":::",
      "",
      "## Dateien",
      "",
      "Die Fassung liegt als [Markenrichtlinien-2026.pdf](attach://Pdf001) vor, Vorlage auf [Affinity Designer](https://affinity.serif.com).",
      "Hintergrund in [Kickoff](note://Kick01), Werte unter [Akzentfarbe](note://Farb01#akzentfarbe), Fragen an design@kolb-antik.de. #marke",
      "",
      "[Markenrichtlinien-2026.pdf](attach://Pdf001)",
      "[2026-10-07_Markenrichtlinien_Kolb-Antik_Druckfassung_mit_Beschnitt_und_Schnittmarken_final.pdf](attach://Long01)",
    ].join("\n"),
    notebookId: "Nb0001",
    locale: "de",
    references: {
      notes: new Map([["Farb01", "Farbsystem"]]),
      attachments: new Map([["Pdf001", { filename: "Markenrichtlinien-2026.pdf", sizeBytes: 4_200_000 }]]),
    },
  });
  browser = await launchBrowser();
  page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  await page.setContent(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style><style>* { transition: none !important; }</style></head>` +
      `<body class="k2b-ui cloud-app-canvas" style="--app-accent:#0d9488"><button id="start">Start</button><i id="tag-ink" style="color:var(--color-emerald-700)"></i>` +
      `<article id="book" class="notebook-book-content">${html}</article></body></html>`,
  );
}, 60_000);
afterAll(async () => {
  await browser?.close();
});

const geometry = () =>
  page.evaluate(() => {
    const round = (rect: DOMRect) => [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value * 100) / 100).join(",");
    const root = document.getElementById("book")!;
    const boxes: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) boxes.push(round(rect));
    }
    return boxes;
  });

test(`Book links keep every line box on hover and keyboard focus in ${browserName}`, async () => {
  const before = await geometry();
  const count = await page.locator("#book a").count();
  expect(count).toBeGreaterThanOrEqual(8);
  for (let index = 0; index < count; index++) {
    const link = page.locator("#book a").nth(index);
    await link.hover();
    expect(await geometry()).toEqual(before);
    await page.focus("#start");
    await page.keyboard.press("Shift");
    const outline = await link.evaluate((a) => {
      a.focus();
      return [a.matches(":focus-visible"), getComputedStyle(a).outlineStyle];
    });
    expect(outline).toEqual([true, "solid"]);
    expect(await geometry()).toEqual(before);
  }
}, 30_000);

test(`Book references read as calm pills and web links as quiet text in ${browserName}`, async () => {
  await page.mouse.move(0, 0);
  await page.focus("#start");
  const result = await page.evaluate(() => {
    const root = document.getElementById("book")!;
    const ink = getComputedStyle(root.querySelector("p")!).color;
    const style = (selector: string) => getComputedStyle(root.querySelector(selector)!);
    const web = style('a[data-link="web"]');
    return {
      pills: [...root.querySelectorAll<HTMLElement>("a.k2b-reference")].map((a) => [
        a.dataset.reference,
        getComputedStyle(a).color === ink,
      ]),
      fills: new Set([...root.querySelectorAll("a.k2b-reference")].map((a) => getComputedStyle(a).backgroundColor)).size,
      web: [web.color === ink, web.textDecorationLine],
      // The table of contents is quiet text, not a blue link.
      toc: style(".notebook-book-toc a").color === ink,
      tag: style("a.notebook-book-tag").color === getComputedStyle(document.getElementById("tag-ink")!).color,
      crumb: root.querySelector(".k2b-reference__document")?.textContent,
      sizes: [...root.querySelectorAll(".k2b-reference__size")].map((size) => size.textContent),
    };
  });
  expect(result).toEqual({
    pills: [
      ["pdf", true],
      ["note", true],
      ["heading", true],
      ["pdf", true],
      ["pdf", true],
    ],
    fills: 1,
    web: [true, "underline"],
    toc: true,
    // Tags stay as they are.
    tag: true,
    crumb: "Farbsystem ›",
    sizes: ["4,2 MB"],
  });
});
