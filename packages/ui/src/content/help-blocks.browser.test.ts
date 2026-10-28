import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../test/browser";

// The unit harness compiles without hydration keys. This bundle compiles the
// components for the server with hydration keys, in a build of its own: a
// process-wide loader plugin would also compile every other test's components.
const serverEntry = resolve(import.meta.dir, "help-blocks.server-fixture.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [serverEntry]: `
import { createComponent } from "solid-js";
import { generateHydrationScript, renderToString } from "solid-js/web";
import { Kbd } from "./Kbd";
import { LabelChip } from "./LabelChip";
import { Steps } from "./Steps";
const html = (component, props) => renderToString(() => createComponent(component, props));
export const serverCaps = { other: html(Kbd, { keys: "mod+k" }), apple: html(Kbd, { keys: "mod+k", platform: "apple" }) };
export const hydrationScript = generateHydrationScript();
export const chip = html(LabelChip, { children: "Share" });
export const iconChip = html(LabelChip, { icon: "ti ti-share", children: "Share" });
export const steps = html(Steps, { start: 3, children: "Instructions" });
`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [
    {
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
    },
  ],
});
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle the server fixture");
const serverDir = mkdtempSync(resolve(tmpdir(), "k2b-ui-help-blocks-"));
process.once("exit", () => rmSync(serverDir, { recursive: true, force: true }));
const serverModule = resolve(serverDir, "server.mjs");
writeFileSync(serverModule, await serverBuild.outputs[0]!.text());
const {
  serverCaps,
  hydrationScript,
  chip,
  iconChip,
  steps,
}: {
  serverCaps: { other: string; apple: string };
  hydrationScript: string;
  chip: string;
  iconChip: string;
  steps: string;
} = await import(serverModule);
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
let errors: string[];
beforeAll(async () => {
  browser = await launchBrowser();
  page = await browser.newPage();
  errors = pageErrors(page);
});
afterAll(async () => {
  await page?.close();
  await browser?.close();
});

for (const mode of ["other", "apple"] as const)
  test(`real hydration preserves the first ${mode} markup on Apple`, async () => {
    errors.length = 0;
    await page.setContent(
      `<html lang="en"><body class="k2b-ui" data-mode="${mode}"><div id="app">${serverCaps[mode]}</div>${hydrationScript}</body></html>`,
    );
    await page.addScriptTag({ content: script });
    await page.waitForSelector('body[data-ready="true"]');
    expect(await page.locator("body").getAttribute("data-first")).toBe(serverCaps[mode]);
    expect(await page.locator("body").getAttribute("data-reused")).toBe("true");
    expect(await page.locator(".k2b-kbd__keys").textContent()).toBe("⌘K");
    expect(errors).toEqual([]);
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
      await page.setContent(
        `<style>${css}${icons}</style><div class="k2b-ui" style="font-size:${fontSize}px;line-height:${lineHeight}"><p id="plain">Select Share now.</p>${[chip, iconChip, serverCaps.apple].map((html, index) => `<p id="p${index}">Select ${html} now.</p>`).join("")}</div>`,
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

test("a key cap stands out from a surface-coloured panel in dark mode", async () => {
  const panel = (attributes: string) => `<div ${attributes} style="background:var(--k2b-surface)"><p>${serverCaps.other}</p></div>`;
  await page.setContent(
    `<style>${css}</style>${panel('id="light" class="k2b-ui"')}${panel('id="theme" class="k2b-ui" data-theme="dark"')}${panel('id="class" class="k2b-ui k2b-dark"')}<div class="dark">${panel('id="ancestor" class="k2b-ui"')}</div>`,
  );
  const surfaces = await page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll<HTMLElement>(".k2b-ui")].map((panel) => [
        panel.id,
        {
          panel: getComputedStyle(panel).backgroundColor,
          cap: getComputedStyle(panel.querySelector(".k2b-kbd__key")!).backgroundColor,
          muted: getComputedStyle(panel).getPropertyValue("--k2b-surface-muted").trim(),
        },
      ]),
    ),
  );
  expect(surfaces.light!.cap).toBe(surfaces.light!.panel);
  for (const id of ["theme", "class", "ancestor"]) {
    expect(surfaces[id]!.cap, id).not.toBe(surfaces[id]!.panel);
    expect(surfaces[id]!.cap, id).toBe("rgb(32, 36, 42)");
    expect(surfaces[id]!.muted, id).toBe("#20242a");
  }
});

test("Steps numbers use the host accent or action token on a transparent list", async () => {
  const html = steps;
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

test("Steps in rendered Markdown content keep their numbers and no list marker", async () => {
  // Trusted HTML such as Help uses the Steps class inside MarkdownView, whose own lists are numbered.
  await page.setContent(
    `<style>${css}</style><div class="k2b-ui"><div class="k2b-content-markdown">${steps.replace("Instructions", "<li>Copy the link.</li>")}</div></div>`,
  );
  const list = await page.evaluate(() => {
    const ol = document.querySelector("ol")!;
    return { style: getComputedStyle(ol).listStyleType, padding: getComputedStyle(ol).paddingLeft };
  });
  expect(list).toEqual({ style: "none", padding: "0px" });
});
