import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import type { Browser, ConsoleMessage } from "playwright";
import { launchBrowser } from "../../test/browser";

// A server-rendered field takes typing before its island hydrates, for example right after opening a chat by its
// address. What the person typed there stays in the field and reaches the owner's state; nothing is lost.
const composer = `
import { createComponent, createEffect, createSignal } from "solid-js";
function Composer(props) {
  const [value, setValue] = createSignal(props.initial ?? "");
  // Like the Assistant, an owner may restore a saved draft in an effect while it hydrates.
  if (typeof window !== "undefined" && window.restoreDraft) createEffect(() => setValue(window.restoreDraft));
  return createComponent(Chat.Composer, {
    get value() { return value(); },
    onValueChange: (next) => {
      setValue(next);
      if (typeof window !== "undefined") window.composerValues = [...(window.composerValues ?? []), next];
    },
    onSubmit: (input) => { window.composerSubmits = [...(window.composerSubmits ?? []), input.text]; },
  });
}
`;

// As in chat-activity-hydration.browser.test.ts: an isolated hydratable SSR build.
const serverEntry = resolve(import.meta.dir, "chat-composer-hydration.server-fixture.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [serverEntry]: `
import { Chat } from "../index";
import { generateHydrationScript, renderToString } from "solid-js/web";
${composer}
export const empty = renderToString(() => createComponent(Composer, {}));
export const prefilled = renderToString(() => createComponent(Composer, { initial: "Von der App vorbelegt" }));
export const hydrationScript = generateHydrationScript();
`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [
    {
      name: "chat-composer-hydration-ssr",
      setup(builder) {
        builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
          const result = await transformAsync(await Bun.file(path).text(), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "ssr", hydratable: true }]],
          });
          if (!result?.code) throw new Error(`Could not compile ${path}`);
          return { contents: result.code, loader: "js" };
        });
      },
    },
  ],
});
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle the composer server fixture");
const serverDir = mkdtempSync(resolve(tmpdir(), "k2b-ui-chat-composer-hydration-"));
process.once("exit", () => rmSync(serverDir, { recursive: true, force: true }));
const serverModule = resolve(serverDir, "server.mjs");
writeFileSync(serverModule, await serverBuild.outputs[0]!.text());
const { empty, prefilled, hydrationScript }: { empty: string; prefilled: string; hydrationScript: string } = await import(serverModule);
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const browserEntry = resolve(import.meta.dir, "../../dist/browser/index.js");
const fixturePath = resolve(import.meta.dir, "chat-composer-hydration.fixture.ts");
const fixture = `
import { Chat } from ${JSON.stringify(browserEntry)};
import { hydrate } from "solid-js/web";
${composer}
hydrate(() => createComponent(Composer, { initial: window.initialValue }), document.getElementById("app"));
requestAnimationFrame(() => requestAnimationFrame(() => { document.body.dataset.ready = "true"; }));
`;
const build = await Bun.build({ entrypoints: [fixturePath], files: { [fixturePath]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle the composer hydration fixture");
const script = await build.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
});

test("text typed into the server-rendered field before hydration stays and reaches the owner", async () => {
  const page = await browser.newPage({ colorScheme: "light", viewport: { width: 1440, height: 800 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() === "error" || /hydrat/i.test(message.text())) errors.push(message.text());
  };
  const onError = (error: Error) => errors.push(error.message);
  page.on("console", onConsole);
  page.on("pageerror", onError);
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><style>${css}
      body { margin:0; padding:16px; }</style></head><body class="k2b-ui" data-theme="light"><div id="app">${empty}</div>${hydrationScript}</body></html>`);
    const field = page.getByRole("textbox");
    // The island has not loaded yet: the person types into the server's field.
    await field.click();
    await page.keyboard.insertText("Hallo Gustav");
    expect(await field.inputValue()).toBe("Hallo Gustav");

    await page.addScriptTag({ content: script });
    await page.waitForSelector('body[data-ready="true"]');
    expect(await field.inputValue()).toBe("Hallo Gustav");
    expect(await page.evaluate(() => (window as unknown as { composerValues?: string[] }).composerValues?.at(-1))).toBe("Hallo Gustav");

    // Once hydrated, Enter sends what was typed before.
    await field.press("Enter");
    expect(await page.evaluate(() => (window as unknown as { composerSubmits?: string[] }).composerSubmits)).toEqual(["Hallo Gustav"]);
    expect(errors).toEqual([]);
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onError);
    await page.close();
  }
});

test("a draft the owner restores while hydrating stays, and the typed text follows it", async () => {
  const page = await browser.newPage({ colorScheme: "light", viewport: { width: 1440, height: 800 }, reducedMotion: "reduce" });
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" data-theme="light"><div id="app">${empty}</div>${hydrationScript}</body></html>`,
    );
    await page.evaluate(() => {
      (window as unknown as { restoreDraft: string }).restoreDraft = "Gespeicherter Entwurf";
    });
    const field = page.getByRole("textbox");
    await field.click();
    await page.keyboard.insertText("Hallo Gustav");
    await page.addScriptTag({ content: script });
    await page.waitForSelector('body[data-ready="true"]');
    expect(await field.inputValue()).toBe("Gespeicherter Entwurf\nHallo Gustav");
    expect(await page.evaluate(() => (window as unknown as { composerValues?: string[] }).composerValues?.at(-1))).toBe(
      "Gespeicherter Entwurf\nHallo Gustav",
    );
  } finally {
    await page.close();
  }
});

test("an untouched field the owner rendered with text hydrates to that text and reports no change", async () => {
  const page = await browser.newPage({ colorScheme: "light", viewport: { width: 1440, height: 800 }, reducedMotion: "reduce" });
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" data-theme="light"><div id="app">${prefilled}</div>${hydrationScript}</body></html>`,
    );
    await page.evaluate(() => {
      (window as unknown as { initialValue: string }).initialValue = "Von der App vorbelegt";
    });
    await page.addScriptTag({ content: script });
    await page.waitForSelector('body[data-ready="true"]');
    expect(await page.getByRole("textbox").inputValue()).toBe("Von der App vorbelegt");
    expect(await page.evaluate(() => (window as unknown as { composerValues?: string[] }).composerValues)).toBeUndefined();
  } finally {
    await page.close();
  }
});

test("an untouched server-rendered field hydrates without reporting a change", async () => {
  const page = await browser.newPage({ colorScheme: "light", viewport: { width: 1440, height: 800 }, reducedMotion: "reduce" });
  try {
    await page.setContent(
      `<!doctype html><html lang="en"><head><style>${css}</style></head><body class="k2b-ui" data-theme="light"><div id="app">${empty}</div>${hydrationScript}</body></html>`,
    );
    await page.addScriptTag({ content: script });
    await page.waitForSelector('body[data-ready="true"]');
    expect(await page.getByRole("textbox").inputValue()).toBe("");
    expect(await page.evaluate(() => (window as unknown as { composerValues?: string[] }).composerValues)).toBeUndefined();
  } finally {
    await page.close();
  }
});
