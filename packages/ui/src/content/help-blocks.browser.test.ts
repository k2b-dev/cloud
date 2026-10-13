import { afterAll, beforeAll, expect, test } from "bun:test";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createComponent } from "solid-js";
import { generateHydrationScript, renderToString } from "solid-js/web";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";

// The unit harness compiles without hydration keys. Compile real SSR markup
// with hydration keys here and hydrate it with the shipped browser component.
Bun.plugin({
  name: "help-hydration-ssr",
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
});
const { Kbd } = await import("./Kbd");
const { LabelChip } = await import("./LabelChip");
const { Steps } = await import("./Steps");
const css = readFileSync(resolve(import.meta.dir, "../../dist/styles.css"), "utf8");
const icons = readFileSync(resolve(import.meta.dir, "../../dist/tabler.css"), "utf8").replace(
  /url\(\.\/([^)?]+)(?:\?[^)]*)?\)/g,
  (_match: string, file: string) =>
    `url(data:font/woff2;base64,${readFileSync(resolve(import.meta.dir, "../../dist", file)).toString("base64")})`,
);
const browserEntry = resolve(import.meta.dir, "../../dist/browser/index.js");
const fixturePath = resolve(import.meta.dir, "help-blocks.fixture.ts");
const fixture = `
import { createComponent } from "solid-js";
import { hydrate, render } from "solid-js/web";
import { Kbd } from ${JSON.stringify(browserEntry)};
Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
const root = document.getElementById("app");
const mode = document.body.dataset.mode;
if (mode === "client") {
  render(() => {
    const element = createComponent(Kbd, { keys: "mod+k" });
    const content = typeof element === "function" ? element() : element;
    document.body.dataset.first = content.textContent;
    return element;
  }, root);
} else {
  const cap = root.querySelector("kbd");
  hydrate(() => {
    const element = createComponent(Kbd, { keys: "mod+k", platform: mode === "apple" ? "apple" : undefined });
    if (typeof element === "function") element();
    document.body.dataset.first = root.innerHTML;
    document.body.dataset.reused = String(root.querySelector("kbd") === cap);
    return element;
  }, root);
}
document.body.dataset.ready = "true";
`;
const build = await Bun.build({ entrypoints: [fixturePath], files: { [fixturePath]: fixture }, target: "browser", format: "iife" });
if (!build.success) throw new AggregateError(build.logs, "Could not bundle Kbd hydration fixture");
const script = await build.outputs[0]!.text();
let browser: Browser;
let page: Page;
const serverCaps = {
  other: renderToString(() => createComponent(Kbd, { keys: "mod+k" })),
  apple: renderToString(() => createComponent(Kbd, { keys: "mod+k", platform: "apple" })),
};
beforeAll(async () => {
  browser = await launchBrowser();
  page = await browser.newPage();
});
afterAll(async () => {
  await page?.close();
  await browser?.close();
});

for (const mode of ["other", "apple"] as const)
  test(`real hydration preserves the first ${mode} markup on Apple`, async () => {
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    try {
      await page.setContent(
        `<html lang="en"><body class="k2b-ui" data-mode="${mode}"><div id="app">${serverCaps[mode]}</div>${generateHydrationScript()}</body></html>`,
      );
      await page.addScriptTag({ content: script });
      await page.waitForSelector('body[data-ready="true"]');
      expect(await page.locator("body").getAttribute("data-first")).toBe(serverCaps[mode]);
      expect(await page.locator("body").getAttribute("data-reused")).toBe("true");
      expect(await page.locator(".k2b-kbd__keys").textContent()).toBe("⌘K");
      expect(errors).toEqual([]);
    } finally {
      page.off("pageerror", onError);
    }
  });
test("a client render detects Apple on its first render", async () => {
  await page.setContent('<!doctype html><html lang="en"><body data-mode="client"><div id="app"></div></body></html>');
  await page.addScriptTag({ content: script });
  await page.waitForSelector('body[data-ready="true"]');
  expect(await page.locator("body").getAttribute("data-first")).toContain("⌘K");
});

test("inline chips and caps do not grow paragraphs", async () => {
  for (const fontSize of [16, 14])
    for (const lineHeight of [1.6, 1.5, 1.25]) {
      const chip = renderToString(() => createComponent(LabelChip, { children: "Share" }));
      const icon = renderToString(() => createComponent(LabelChip, { icon: "ti ti-share", children: "Share" }));
      const cap = renderToString(() => createComponent(Kbd, { keys: "mod+k", platform: "apple" }));
      await page.setContent(
        `<style>${css}${icons}</style><div class="k2b-ui" style="font-size:${fontSize}px;line-height:${lineHeight}"><p id="plain">Select Share now.</p>${[chip, icon, cap].map((html, index) => `<p id="p${index}">Select ${html} now.</p>`).join("")}</div>`,
      );
      // The icon is measured with its real glyph, so the icon font's metrics count.
      const glyph = await page.evaluate(async () => {
        await document.fonts.load('16px "tabler-icons"');
        await document.fonts.ready;
        const icon = document.querySelector(".k2b-label-chip > i")!;
        return { loaded: document.fonts.check('16px "tabler-icons"'), width: icon.getBoundingClientRect().width };
      });
      expect(glyph.loaded).toBe(true);
      expect(glyph.width).toBeGreaterThan(0);
      const dimensions = await page.evaluate(() => {
        const plain = document.getElementById("plain")!.getBoundingClientRect().height;
        return [...document.querySelectorAll<HTMLElement>("p:not(#plain)")].map((p) => ({
          plain,
          paragraph: p.getBoundingClientRect().height,
          inline: p.querySelector(".k2b-label-chip, .k2b-kbd")!.getBoundingClientRect().height,
          line: Number.parseFloat(getComputedStyle(p).lineHeight),
        }));
      });
      for (const dimension of dimensions) {
        expect(dimension.inline, `${fontSize}px/${lineHeight}`).toBeLessThanOrEqual(dimension.line);
        expect(dimension.paragraph, `${fontSize}px/${lineHeight}`).toBe(dimension.plain);
      }
    }
});

test("Steps numbers use the host accent or action token on a transparent list", async () => {
  const html = renderToString(() => createComponent(Steps, { start: 3, children: "Instructions" }));
  // The render test owns li markup; these real li elements expose their pseudo-element styles.
  await page.setContent(
    `<style>${css}</style><div class="k2b-ui" style="--k2b-action:rgb(0, 0, 255);--k2b-text:rgb(0, 0, 0)"><div id="fallback">${html.replace("Instructions", "<li>Copy the link.</li>")}</div><div id="accent" style="--app-accent:rgb(255, 0, 0)">${html.replace("Instructions", "<li>Copy the link.</li>")}</div></div>`,
  );
  const colors = await page.evaluate(() => {
    const values = (id: string) => {
      const list = document.querySelector(`#${id} ol`)!;
      return {
        color: (() => {
          const canvas = document.createElement("canvas").getContext("2d")!;
          canvas.fillStyle = getComputedStyle(list.querySelector("li")!, "::before").color;
          canvas.fillRect(0, 0, 1, 1);
          return Array.from(canvas.getImageData(0, 0, 1, 1).data);
        })(),
        background: getComputedStyle(list).backgroundColor,
        counter: getComputedStyle(list).counterReset,
      };
    };
    return { fallback: values("fallback"), accent: values("accent") };
  });
  expect(colors.fallback.color[0]).toBe(0);
  expect(colors.fallback.color[2]).toBeGreaterThanOrEqual(178);
  expect(colors.accent.color[0]).toBeGreaterThanOrEqual(178);
  expect(colors.accent.color[2]).toBe(0);
  expect(colors.fallback.background).toBe("rgba(0, 0, 0, 0)");
  expect(colors.accent.background).toBe("rgba(0, 0, 0, 0)");
  expect(colors.accent.counter).toBe("k2b-step 2");
});
