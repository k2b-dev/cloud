import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

// Whether a long system line shows its whole sentence depends on the shipped cascade, so a real engine lays it out
// at phone and desktop widths.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-chat-activity-wrap-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Chat } = await import("../index");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const sentence =
  "Stopped while the routine was running. Already done: Created row “Invoice 2026-114” in Invoices 2026; Added to note “New invoices”. Nothing was undone.";
const html = (wrap: boolean) => renderToString(() => createComponent(Chat.Activity, { label: sentence, icon: "ti ti-player-stop", wrap }));

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const measure = async (wrap: boolean, width: number) => {
  const page = await browser.newPage({ viewport: { width, height: 600 }, colorScheme: "light" });
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:16px">${html(wrap)}</body></html>`,
    );
    return await page.$eval(".k2b-chat-activity", (activity) => {
      const label = activity.querySelector<HTMLElement>(".k2b-chat-activity__copy strong")!;
      const icon = activity.querySelector<HTMLElement>(".k2b-chat-activity__leading")!.getBoundingClientRect();
      const text = label.getBoundingClientRect();
      const style = getComputedStyle(label);
      // `normal` has no number; a line is then about 1.2 times the font size.
      const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
      return {
        hidden: label.scrollWidth - label.clientWidth,
        lines: Math.round(text.height / lineHeight),
        // The icon sits on the first line, not in the middle of the sentence.
        iconOnFirstLine: icon.top < text.top + lineHeight,
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
  } finally {
    await page.close();
  }
};

for (const width of [390, 1440]) {
  test(`a wrapping activity shows its whole sentence at ${width} px`, async () => {
    const wrapped = await measure(true, width);
    expect(wrapped.hidden).toBe(0);
    expect(wrapped.page).toBe(0);
    expect(wrapped.iconOnFirstLine).toBe(true);
    if (width === 390) expect(wrapped.lines).toBeGreaterThan(1);
  });
}

test("an activity without wrap keeps its one line", async () => {
  const single = await measure(false, 390);
  expect(single.lines).toBe(1);
  expect(single.hidden).toBeGreaterThan(0);
});
