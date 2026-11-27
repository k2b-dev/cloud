import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { browserName, launchBrowser, launchHookMs, pageErrors, settled } from "../../test/browser";
import { bundleV2Entry } from "../../test/v2-bundle";
import type {} from "../../test/v2-table-ssr.client";

// What the server sends is what the first frame shows (test/v2-table-ssr.fixture.tsx): a narrow table drops the same
// columns in the server's markup as after hydration (the stylesheet decides, not a measurement), and a table that
// scrolls sideways has the same height before and after, with real scrollbars, so nothing moves.

const css = readFileSync(resolve(import.meta.dir, "v2.css"), "utf8");
const testCss =
  "html, body { margin: 0; height: 100%; } #root { position: fixed; inset: 0; display: flex; } .ti { display: inline-block; width: 1em; height: 1em; }";

let browser: Browser;
let client: string;
let server: { html: string; script: string };
const temp = mkdtempSync(resolve(tmpdir(), "k2-v2-table-ssr-"));
beforeAll(async () => {
  const serverFile = resolve(temp, "server.js");
  await Bun.write(serverFile, await bundleV2Entry("v2-table-ssr.server.tsx", "ssr"));
  const { render }: { render: () => { html: string; script: string } } = await import(serverFile);
  server = render();
  // Chromium hides scrollbars in tests by default; this one needs them, as a person's browser draws them
  const options = browserName === "chromium" ? { ignoreDefaultArgs: ["--hide-scrollbars"] } : {};
  [client, browser] = await Promise.all([bundleV2Entry("v2-table-ssr.client.tsx", "dom"), launchBrowser(options)]);
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
  rmSync(temp, { recursive: true, force: true });
});

/** The columns in sight and the height of each table's box. */
const tables = () =>
  Object.fromEntries(
    [...document.querySelectorAll<HTMLElement>(".k2-table-scroll")].map((scroll) => [
      scroll.querySelector("table")?.getAttribute("aria-label") ?? "",
      {
        shown: [...scroll.querySelectorAll<HTMLElement>("thead th")]
          .filter((head) => head.getBoundingClientRect().width > 0)
          .map((head) => head.textContent?.trim() ?? ""),
        height: Math.round(scroll.getBoundingClientRect().height),
      },
    ]),
  );

const withPage = async (run: (page: Page) => Promise<void>) => {
  const page = await browser.newPage({ viewport: { width: 640, height: 800 } });
  page.setDefaultTimeout(2000);
  const errors = pageErrors(page);
  try {
    await page.setContent(
      `<!doctype html><html lang="de"><head><meta charset="utf-8">${server.script}<style>${css}</style><style>${testCss}</style></head><body class="k2-ui"><div id="root">${server.html}</div></body></html>`,
    );
    await run(page);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
};

test("at 640 px the server's markup and the hydrated page show the same columns and the same heights", async () => {
  await withPage(async (page) => {
    // settled: the server's markup before any script is the subject
    const sent = await page.evaluate(tables);
    expect(sent.Dateien?.shown).toEqual(["Name", "Besitzer", "Größe"]);
    expect(sent.Termine?.shown).toEqual(["Titel", "Zeitraum", "Ort", "Leitung", "Notiz"]);
    await page.addScriptTag({ content: client });
    await page.waitForFunction(() => window.__k2Hydrated === true);
    await settled(page);
    expect(await page.evaluate(tables)).toEqual(sent);
    // the wide one scrolls, and says so at its end
    expect(
      await page.evaluate(() =>
        document.querySelector('table[aria-label="Termine"]')!.closest(".k2-table-scroll")!.hasAttribute("data-more-end"),
      ),
    ).toBe(true);
  });
});
