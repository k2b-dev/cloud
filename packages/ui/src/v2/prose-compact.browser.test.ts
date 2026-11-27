import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { registerSsrTestPlugin } from "../../test/ssr-test-plugin";

// Short text a person wrote, such as a comment (Notebooks, W2): `Prose compact` shows it as text. An image shows its
// words, a table its rows as lines of text, a heading is no larger than the text; links and inline code stay.

const root = mkdtempSync(resolve(tmpdir(), "k2-v2-prose-compact-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { Prose } = await import("./content");
const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");

const comment = [
  "# Bitte prüfen",
  "",
  "Siehe ![Grundriss](https://example.org/plan.png) und die [Liste](https://example.org/liste), Feld `menge`.",
  "",
  "| Artikel | Menge |",
  "|---|--:|",
  "| Stuhl | 2 |",
  "| Tisch | 1 |",
].join("\n");

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

test("a compact Prose shows an image as its words and a table as lines of text, with headings at the size of the text", async () => {
  const markup = renderToString(() => createComponent(Prose, { markdown: comment, compact: true }));
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8"><style>${css}</style></head><body class="k2-ui">${markup}</body></html>`,
    );
    await settled(page);
    const found = await page.evaluate(() => {
      const prose = document.querySelector(".k2-prose")!;
      const size = (selector: string) => getComputedStyle(prose.querySelector(selector)!).fontSize;
      return {
        media: prose.querySelectorAll("img, table, video, iframe, picture").length,
        text: prose.textContent!.replace(/\s+/g, " ").trim(),
        link: prose.querySelector("a")?.getAttribute("href"),
        code: prose.querySelector("code")?.textContent,
        heading: size("h1"),
        body: size("p"),
      };
    });
    expect(found.media).toBe(0);
    expect(found.text).toContain("Grundriss");
    expect(found.text).toContain("Stuhl · 2");
    expect(found.text).toContain("Tisch · 1");
    expect(found.link).toBe("https://example.org/liste");
    expect(found.code).toBe("menge");
    expect(found.heading).toBe(found.body);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
});
