import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import type { Browser, BrowserContextOptions } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser } from "../../test/browser";

// Whether a busy label stays visible depends on which rule wins in the cascade, so a real engine renders the shipped
// stylesheet.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-chat-activity-motion-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { Chat } = await import("../index");

const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const html = renderToString(() => createComponent(Chat.Activity, { label: "Checking the app", icon: "ti ti-checklist", busy: true }));

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

/** How the icon and the label of a busy activity paint their text. */
const paint = async (options: BrowserContextOptions) => {
  const page = await browser.newPage(options);
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:16px">${html}</body></html>`,
    );
    return await page.$$eval(".k2b-chat-activity__leading, .k2b-chat-activity__copy strong", (nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node);
        return { fill: style.webkitTextFillColor, color: style.color, animation: style.animationName };
      }),
    );
  } finally {
    await page.close();
  }
};

test("a busy activity shimmers its icon and label with motion", async () => {
  const parts = await paint({ reducedMotion: "no-preference" });
  expect(parts).toHaveLength(2);
  for (const part of parts) expect(part).toMatchObject({ fill: "rgba(0, 0, 0, 0)", animation: "k2b-chat-activity-shimmer" });
});

test("a busy activity keeps its icon and label in their own colour with reduced motion", async () => {
  const parts = await paint({ reducedMotion: "reduce" });
  expect(parts).toHaveLength(2);
  for (const part of parts) {
    expect(part.animation).toBe("none");
    expect(part.fill).not.toBe("rgba(0, 0, 0, 0)");
    expect(part.fill).toBe(part.color);
  }
});

test("a busy activity keeps its icon and label visible in forced colours", async () => {
  const parts = await paint({ forcedColors: "active" });
  expect(parts).toHaveLength(2);
  for (const part of parts) expect(part.fill).not.toBe("rgba(0, 0, 0, 0)");
});

test("a press on a row's text opens it, also when the text is replaced between press and release", async () => {
  const row = renderToString(() =>
    createComponent(Chat.Activity, {
      label: "Running code",
      trailing: "0:41 · 9 steps",
      children: "Steps",
    }),
  );
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" style="margin:0;padding:16px">${row}</body></html>`,
    );
    const trailing = (await page.locator(".k2b-chat-activity__trailing").boundingBox())!;
    await page.mouse.move(trailing.x + trailing.width / 2, trailing.y + trailing.height / 2);
    await page.mouse.down();
    // A live row re-renders its clock every second: the node under the pointer is replaced while it is pressed.
    await page.$eval(".k2b-chat-activity__trailing", (node) => node.replaceWith(node.cloneNode(true)));
    await page.mouse.up();
    expect(await page.$eval("details", (node) => (node as HTMLDetailsElement).open)).toBe(true);
  } finally {
    await page.close();
  }
});
