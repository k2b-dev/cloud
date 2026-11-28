import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import type { BunPlugin } from "bun";
import type { Browser, ConsoleMessage } from "playwright";
import { launchBrowser, launchHookMs } from "../../../../ui/test/browser";

// The shared document page as the server sends it and the browser takes it over: rendered with hydration keys on the
// server, hydrated in the page, the same elements, texts and link, and no hydration error. The UI source is compiled
// too, since its distributed SSR build has no hydration keys.
const ui = resolve(import.meta.dir, "../../../../ui");
const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
const directory = mkdtempSync(resolve(tmpdir(), "grids-public-hydration-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));

const fixturePath = resolve(import.meta.dir, "public.hydration-fixture.tsx");
const fixture = `
import { LocaleProvider } from "@k2b/ui";
import { PublicDocumentShare } from "./documents/[token]/PublicDocumentShare";
export function Fixture() {
  return <LocaleProvider locale="de"><main class="k2-ui minimal-layout-main">
    <PublicDocumentShare filename="Rechnung-2026-0042.pdf" mimeType="application/pdf" expiresAt="2099-12-02T18:00:00.000Z"
      expiresAtLabel="2. Dezember 2099 um 19:00" downloadHref="/share/grids/documents/gdl_test/download" />
  </main></LocaleProvider>;
}
`;
const compile = (generate: "ssr" | "dom"): BunPlugin => ({
  name: `grids-public-hydration-${generate}`,
  setup(builder) {
    builder.onResolve({ filter: /^@k2b\/ui$/ }, () => ({ path: resolve(ui, "src/index.ts") }));
    builder.onResolve({ filter: /^@k2b\/ui\/v2$/ }, () => ({ path: resolve(ui, "src/v2/index.ts") }));
    builder.onResolve({ filter: /public\.hydration-fixture$/ }, () => ({ path: fixturePath, namespace: "grids-fixture" }));
    for (const namespace of ["file", "grids-fixture"])
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

const serverEntry = resolve(import.meta.dir, "public.hydration-server.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [fixturePath]: fixture,
    [serverEntry]: `
import { createComponent } from "solid-js";
import { renderToString, generateHydrationScript } from "solid-js/web";
import { Fixture } from "./public.hydration-fixture";
export const render = () => renderToString(() => createComponent(Fixture, {}));
export const hydrationScript = generateHydrationScript();`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [compile("ssr")],
});
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle the public document SSR fixture");
const modulePath = resolve(directory, "server.mjs");
writeFileSync(modulePath, await serverBuild.outputs[0]!.text());
const { render, hydrationScript }: { render: () => string; hydrationScript: string } = await import(modulePath);

const clientEntry = resolve(import.meta.dir, "public.hydration-client.ts");
const clientBuild = await Bun.build({
  entrypoints: [clientEntry],
  files: {
    [fixturePath]: fixture,
    [clientEntry]: `
import { createComponent } from "solid-js";
import { hydrate } from "solid-js/web";
import { Fixture } from "./public.hydration-fixture";
hydrate(() => createComponent(Fixture, {}), document.getElementById("app"));
document.body.dataset.hydrated = "true";`,
  },
  target: "browser",
  conditions: ["browser"],
  format: "iife",
  plugins: [compile("dom")],
});
if (!clientBuild.success) throw new AggregateError(clientBuild.logs, "Could not bundle the public document client fixture");
const script = await clientBuild.outputs[0]!.text();

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, launchHookMs);
afterAll(async () => {
  await browser?.close();
});

test("the shared document page hydrates what the server sent: the same elements, texts and download link", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message: ConsoleMessage) => {
    if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
  });
  try {
    await page.route("http://cloud.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="de"><head><meta charset="utf-8"></head><body class="k2b-ui"><div id="app">${render()}</div>${hydrationScript}</body></html>`,
      }),
    );
    await page.goto("http://cloud.test/share/grids/documents/gdl_test");
    const shape = () =>
      page.evaluate(() => {
        const root = document.getElementById("app");
        return {
          elements: root?.querySelectorAll("*").length ?? 0,
          text: root?.textContent ?? "",
          download: root?.querySelector('a[href$="/download"]')?.getAttribute("href") ?? null,
        };
      });
    const server = await shape();
    expect(server.download).toBe("/share/grids/documents/gdl_test/download");
    await page.addScriptTag({ content: script });
    await page.locator('body[data-hydrated="true"]').waitFor();
    expect(await shape()).toEqual(server);
    expect(errors).toEqual([]);
  } finally {
    await page.close();
  }
}, 30_000);
