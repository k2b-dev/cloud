import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import type { BunPlugin } from "bun";
import tailwind from "bun-plugin-tailwind";
import type { Browser, ConsoleMessage } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";

const solid = (await import(Bun.resolveSync("babel-preset-solid", `${import.meta.dir}/`))).default;

const directory = mkdtempSync(resolve(tmpdir(), "cloud-help-hydration-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const fixturePath = resolve(import.meta.dir, "LayoutHelp.hydration-fixture.tsx");
// Compile UI source too: its distributed SSR build deliberately has no hydration keys.
// Both bundles must use the same hydratable component tree and Solid runtime.
const fixture = `
import { LocaleProvider, keyboardPlatform } from "@k2b/ui";
import { LayoutHelpPage } from "./LayoutHelp";
import { ShellDataProvider } from "./shell-data";
const documents = [
  { id: "share", title: "Share a Space", kind: "task", order: 10 },
  { id: "start", title: "Start with Spaces", kind: "start", order: 5 },
  { id: "access", title: "Access levels", kind: "reference", order: 20 },
  { id: "problems", title: "Solve problems", kind: "troubleshoot", order: 30 },
].map((document) => ({ ...document, url: "/api/help/" + document.id, searchUrl: "/api/help/search" }));
const userAgents = {
  apple: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  other: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36",
};
export function Fixture(props) {
  const data = {
    apps: [{ id: "spaces", label: "Spaces", iconClass: "ti ti-box", href: "/app/spaces", match: "/app/spaces", defaultVisible: true }],
    legalLinks: [], searchLinks: {}, theme: "light", appId: "spaces", platform: keyboardPlatform(userAgents[props.mode]),
  };
  return <LocaleProvider locale="en"><ShellDataProvider data={data}>
    <LayoutHelpPage documents={documents} pageBase="/app/spaces/help" />
  </ShellDataProvider></LocaleProvider>;
}
`;
const compile = (generate: "ssr" | "dom"): BunPlugin => ({
  name: `help-hydration-${generate}`,
  setup(builder) {
    builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: resolve(import.meta.dir, "../../../ui/src/index.ts") }));
    builder.onResolve({ filter: /LayoutHelp\.hydration-fixture$/ }, () => ({ path: fixturePath, namespace: "help-fixture" }));
    for (const namespace of ["file", "help-fixture"])
      builder.onLoad({ filter: /\.tsx$/, namespace }, async ({ path }) => {
        const result = await transformAsync(path === fixturePath ? fixture : await Bun.file(path).text(), {
          filename: path,
          babelrc: false,
          configFile: false,
          presets: [typescript, [solid, { generate, hydratable: true }]],
        });
        if (!result?.code) throw new Error(`Could not compile ${path}`);
        return { contents: result.code, loader: "js", resolveDir: dirname(path) };
      });
  },
});
const serverEntry = resolve(import.meta.dir, "LayoutHelp.hydration-server.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [fixturePath]: fixture,
    [serverEntry]: `
import { createComponent } from "solid-js";
import { renderToString, generateHydrationScript } from "solid-js/web";
import { Fixture } from "./LayoutHelp.hydration-fixture";
export const render = (mode) => renderToString(() => createComponent(Fixture, { mode }));
export const hydrationScript = generateHydrationScript();`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [compile("ssr")],
});
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle Help SSR fixture");
const modulePath = resolve(directory, "server.mjs");
writeFileSync(modulePath, await serverBuild.outputs[0]!.text());
const { render, hydrationScript }: { render: (mode: "apple" | "other") => string; hydrationScript: string } = await import(modulePath);
const clientEntry = resolve(import.meta.dir, "LayoutHelp.hydration-client.ts");
const clientBuild = await Bun.build({
  entrypoints: [clientEntry],
  files: {
    [fixturePath]: fixture,
    [clientEntry]: `
import { createComponent } from "solid-js";
import { hydrate, render } from "solid-js/web";
import { Fixture } from "./LayoutHelp.hydration-fixture";
import { registerContextAwareCommand } from "../browser/command-bridge";
const root = document.getElementById("app");
const shortcuts = root.querySelector("[data-help-shortcuts]");
const island = document.body.dataset.mount === "island";
if (island) {
  // Cloud islands mount as @k2b/ssr's mount() does: clear the server markup and render.
  root.innerHTML = "";
  render(() => createComponent(Fixture, { mode: document.body.dataset.mode }), root);
} else hydrate(() => createComponent(Fixture, { mode: document.body.dataset.mode }), root);
// Before any command has registered, the server's rows must be there in the first client frame too.
const current = root.querySelector("[data-help-shortcuts]");
document.body.dataset.seedPreserved = String(island ? current?.querySelectorAll(".help-shortcut").length === 2 : shortcuts === current);
document.body.dataset.seedKeys = current?.querySelector(".help-shortcut .k2b-kbd__keys")?.textContent;
const box = current?.getBoundingClientRect();
document.body.dataset.firstBox = box ? JSON.stringify([box.x, box.y, box.width, box.height]) : "";
const unregister = [
  { id: "cloud.shell.focus", title: "Hide sidebar", shortcut: "mod+\\\\" },
  { id: "cloud.help", title: "Open shortcut help", shortcut: "shift+/" },
  { id: "cloud.search", title: "Open global search", shortcut: "mod+k" },
  { id: "spaces.new", title: "New task", shortcut: "n" },
].map((command) => registerContextAwareCommand({ ...command, description: "", action() {} }));
window.addEventListener("pagehide", () => unregister.forEach((dispose) => dispose()), { once: true });
document.body.dataset.hydrated = "true";`,
  },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
  plugins: [compile("dom")],
});
if (!clientBuild.success) throw new AggregateError(clientBuild.logs, "Could not bundle Help hydration fixture");
const script = await clientBuild.outputs[0]!.text();
const styles = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../../../styles.css")], plugins: [tailwind] });
if (!styles.success) throw new AggregateError(styles.logs, "Could not compile Help stylesheet");
const css = await styles.outputs[0]!.text();
let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
});
afterAll(async () => {
  await browser?.close();
  rmSync(directory, { recursive: true, force: true });
});

for (const mount of ["island", "hydrate"] as const)
  for (const mode of ["apple", "other"] as const) {
    // Exercise all three reserved shortcut layouts: one, two and three columns.
    for (const width of [390, 768, 1440]) {
      test(`${mount} ${mode} ${width}: the client keeps the server's shortcut geometry and key caps`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message: ConsoleMessage) => {
          if (message.type() === "error") errors.push(message.text());
        });
        try {
          await page.route("http://cloud.test/**", (route) =>
            route.fulfill({
              contentType: "text/html",
              body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body class="k2b-ui" data-mode="${mode}" data-mount="${mount}" style="margin:0"><div id="app">${render(mode)}</div>${hydrationScript}</body></html>`,
            }),
          );
          await page.goto("http://cloud.test/app/spaces/help");
          await page.evaluate((mode) => {
            Object.defineProperty(navigator, "platform", { configurable: true, value: mode === "apple" ? "MacIntel" : "Win32" });
          }, mode);
          await page.evaluate(() => document.fonts.ready);
          const shortcuts = page.locator("[data-help-shortcuts]");
          const searchRow = shortcuts.locator(".help-shortcut").filter({ hasText: "Open global search" });
          const before = await shortcuts.boundingBox();
          expect(before).not.toBeNull();
          expect(await shortcuts.locator(".help-shortcut").count()).toBe(2);
          const keysBefore = await searchRow.locator(".k2b-kbd__keys").textContent();
          expect(keysBefore).toBe(mode === "apple" ? "⌘K" : "CtrlK");
          await page.addScriptTag({ content: script });
          await page.locator('body[data-hydrated="true"]').waitFor();
          await shortcuts.locator(".help-shortcut").filter({ hasText: "New task" }).waitFor();
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          expect(await page.locator("body").getAttribute("data-seed-preserved")).toBe("true");
          expect(await page.locator("body").getAttribute("data-seed-keys")).toBe(keysBefore);
          expect(JSON.parse((await page.locator("body").getAttribute("data-first-box")) ?? "[]")).toEqual([
            before!.x,
            before!.y,
            before!.width,
            before!.height,
          ]);
          expect(await shortcuts.boundingBox()).toEqual(before);
          expect(await searchRow.locator(".k2b-kbd__keys").textContent()).toBe(keysBefore);
          expect(await shortcuts.locator(".help-shortcut").count()).toBe(4);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      }, 30_000);
    }
  }
