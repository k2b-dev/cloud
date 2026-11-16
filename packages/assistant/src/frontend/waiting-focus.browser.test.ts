import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

const ui = resolve(import.meta.dir, "../../../ui");

const buildHarness = async (): Promise<string> => {
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "waiting-focus.browser-harness.ts")],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-waiting-focus-test",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const result = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: result.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!build.success) throw new AggregateError(build.logs, "Waiting focus harness build failed");
  return build.outputs[0]!.text();
};

let browser: Browser;
let script: string;
beforeAll(async () => {
  [script, browser] = await Promise.all([buildHarness(), launchBrowser()]);
});
afterAll(async () => {
  await browser?.close();
});

const filler = Array.from({ length: 40 }, (_, index) => `<p>Nachricht ${index + 1}</p>`).join("");
const open = async (): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  await page.setContent(
    `<!doctype html><html lang="de"><body style="margin:0"><div id="viewport" style="height:600px;overflow:auto"><div id="content">${filler}</div></div><script>${script}</script></body></html>`,
  );
  await page.waitForFunction(() => typeof (window as unknown as { land?: unknown }).land === "function");
  return page;
};
/** Adds a card after a few frames, as a chat that is still loading shows it. */
const addLater = (page: Page, html: string) =>
  page.evaluate((card) => {
    let frames = 0;
    const tick = () => {
      if (++frames < 4) return requestAnimationFrame(tick);
      document.getElementById("content")!.insertAdjacentHTML("beforeend", card);
    };
    requestAnimationFrame(tick);
  }, html);
const land = (page: Page, anchor: string) =>
  page.evaluate((target) => (window as unknown as { land: (a: string) => Promise<void> }).land(target), anchor);
const focused = (page: Page) =>
  page.evaluate(() => ({ tag: document.activeElement?.tagName, text: document.activeElement?.textContent?.trim() ?? "" }));

test("a jump to a version waiting to be switched on focuses the card's main button, also while its chat still loads", async () => {
  const page = await open();
  try {
    await addLater(
      page,
      `<article data-chat-anchor="code-version-v2"><p>Version 2 von Wochenabschluss ist bereit.</p>` +
        `<button class="k2b-button" data-variant="secondary">Ansehen</button>` +
        `<button class="k2b-button" data-variant="primary">Version 2 einschalten</button></article>`,
    );
    await land(page, "code-version-v2");
    expect(await focused(page)).toEqual({ tag: "BUTTON", text: "Version 2 einschalten" });
    // The card stands in view.
    const inView = await page.evaluate(() => {
      const card = document.querySelector("[data-chat-anchor]")!.getBoundingClientRect();
      return card.top >= 0 && card.top < 600;
    });
    expect(inView).toBe(true);
  } finally {
    await page.close();
  }
});

test("a card loaded on demand gets the focus once its module has loaded and its main button is there", async () => {
  const page = await open();
  try {
    // The card's place comes first, without buttons; its module loads after the jump has landed in the chat.
    await page.evaluate(() => {
      document
        .getElementById("content")!
        .insertAdjacentHTML("beforeend", '<article data-chat-anchor="code-version-v3"><p>Version 3 wird geladen …</p></article>');
      setTimeout(async () => {
        const source = 'export const button = () => \'<button class="k2b-button" data-variant="primary">Version 3 einschalten</button>\';';
        const module = await import(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        document.querySelector("[data-chat-anchor='code-version-v3']")!.insertAdjacentHTML("beforeend", module.button());
      }, 1200);
    });
    const started = performance.now();
    await land(page, "code-version-v3");
    expect(await focused(page)).toEqual({ tag: "BUTTON", text: "Version 3 einschalten" });
    expect(performance.now() - started).toBeLessThan(3000);
  } finally {
    await page.close();
  }
}, 30_000);

test("a decision card keeps the focus on its sentence, and a card that never comes is reported gone", async () => {
  const page = await open();
  try {
    await addLater(
      page,
      `<section class="k2b-chat-decision" data-chat-anchor="tool-del-1"><h3 class="k2b-chat-decision__sentence" tabindex="-1">Termin Retro löschen?</h3>` +
        `<button class="k2b-button" data-variant="primary">Retro löschen</button></section>`,
    );
    await land(page, "tool-del-1");
    expect(await focused(page)).toEqual({ tag: "H3", text: "Termin Retro löschen?" });
    await land(page, "code-version-missing");
    expect(await page.evaluate(() => (window as unknown as { gone: boolean }).gone)).toBe(true);
  } finally {
    await page.close();
  }
}, 30_000);
