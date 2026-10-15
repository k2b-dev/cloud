import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../test/browser";
import { type AppWorkspaceLayoutState, appWorkspaceLayoutStyle, parseAppWorkspaceLayoutState } from "./app-workspace-state";

const ui = resolve(import.meta.dir, "../..");
const directory = mkdtempSync(resolve(tmpdir(), "k2b-ui-levels-browser-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const fixturePath = resolve(import.meta.dir, "workspace-levels.fixture.tsx");
const fixture = (entry: string) => `
import { AppWorkspace, serializeAppWorkspaceLayoutState } from ${JSON.stringify(entry)};
export function Fixture(props) {
  return <AppWorkspace.LayoutStateProvider state={props.state}>
    <AppWorkspace onLayoutChange={(state) => { document.cookie = "levels_layout=" + serializeAppWorkspaceLayoutState(state) + "; Path=/; SameSite=Lax"; }}>
      <AppWorkspace.Sidebar label="Navigation"><AppWorkspace.SidebarDesktop>Workspace</AppWorkspace.SidebarDesktop></AppWorkspace.Sidebar>
      <AppWorkspace.Content><AppWorkspace.Main level={props.level}>
        <AppWorkspace.MainPane id="sections" label="Sections" href="/?level=sections" minSize={200} maxSize={720} description="Choose a section">
          <a href="/?level=items">Providers</a>
        </AppWorkspace.MainPane>
        <AppWorkspace.MainPane id="items" label="Items" href="/?level=items"><a href="/?level=item">Model</a></AppWorkspace.MainPane>
        <AppWorkspace.MainPane id="item" label="Item">Selected model</AppWorkspace.MainPane>
      </AppWorkspace.Main></AppWorkspace.Content>
    </AppWorkspace>
  </AppWorkspace.LayoutStateProvider>;
}
`;
const serverEntry = resolve(import.meta.dir, "workspace-levels.server-fixture.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [serverEntry]: `import { createComponent } from "solid-js";
import { renderToString, generateHydrationScript } from "solid-js/web";
import { Fixture } from "./workspace-levels.fixture";
export const render = (level, state) => renderToString(() => createComponent(Fixture, { level, state }));
export const hydrationScript = generateHydrationScript();`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [
    {
      name: "levels-hydration-ssr",
      setup(builder) {
        builder.onResolve({ filter: /workspace-levels\.fixture$/ }, () => ({ path: fixturePath, namespace: "levels-fixture" }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "levels-fixture" }, async ({ path }) => {
          const result = await transformAsync(fixture(resolve(ui, "src/index.ts")), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "ssr", hydratable: true }]],
          });
          if (!result?.code) throw new Error("Could not compile server fixture");
          return { contents: result.code, loader: "js", resolveDir: import.meta.dir };
        });
        builder.onLoad({ filter: /\.tsx$/, namespace: "file" }, async ({ path }) => {
          const source = await Bun.file(path).text();
          const result = await transformAsync(source, {
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
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle levels SSR fixture");
const modulePath = resolve(directory, "server.mjs");
writeFileSync(modulePath, await serverBuild.outputs[0]!.text());
const { render, hydrationScript }: { render: (level: string, state: AppWorkspaceLayoutState | null) => string; hydrationScript: string } =
  await import(modulePath);
const clientEntry = resolve(import.meta.dir, "workspace-levels.client-fixture.ts");
const clientBuild = await Bun.build({
  entrypoints: [clientEntry],
  target: "browser",
  format: "iife",
  files: {
    [clientEntry]: `
import { createComponent } from "solid-js";
import { hydrate } from "solid-js/web";
import { parseAppWorkspaceLayoutState } from ${JSON.stringify(resolve(ui, "dist/browser/index.js"))};
import { Fixture } from "./workspace-levels.fixture";
const state = parseAppWorkspaceLayoutState(document.body.dataset.layout);
hydrate(() => createComponent(Fixture, { level: new URL(location.href).searchParams.get("level") || "item", state }), document.getElementById("app"));
document.body.dataset.ready = "true";`,
  },
  plugins: [
    {
      name: "levels-hydration-dom",
      setup(builder) {
        builder.onResolve({ filter: /workspace-levels\.fixture$/ }, () => ({ path: fixturePath, namespace: "levels-fixture" }));
        builder.onLoad({ filter: /workspace-levels\.fixture\.tsx$/, namespace: "levels-fixture" }, async ({ path }) => {
          const result = await transformAsync(fixture(resolve(ui, "dist/browser/index.js")), {
            filename: path,
            babelrc: false,
            configFile: false,
            presets: [typescript, [solid, { generate: "dom", hydratable: true }]],
          });
          if (!result?.code) throw new Error("Could not compile client fixture");
          return { contents: result.code, loader: "js", resolveDir: import.meta.dir };
        });
      },
    },
  ],
});
if (!clientBuild.success) throw new AggregateError(clientBuild.logs, "Could not bundle levels hydration fixture");
const script = await clientBuild.outputs[0]!.text();
const css = readFileSync(resolve(ui, "dist/styles.css"), "utf8");
let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let origin: string;
beforeAll(async () => {
  browser = await launchBrowser();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/client.js") return new Response(script, { headers: { "Content-Type": "application/javascript" } });
      const encoded = request.headers.get("Cookie")?.match(/(?:^|;\s*)levels_layout=([^;]*)/)?.[1];
      const state = parseAppWorkspaceLayoutState(encoded);
      const body = render(url.searchParams.get("level") || "item", state);
      return new Response(
        `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}html,body{margin:0;width:100%;height:100%;}#app{height:100%;}.k2b-app-workspace{height:100%;}</style></head><body class="k2b-ui" data-layout="${encoded ?? ""}"><div id="app" style="${appWorkspaceLayoutStyle(state) ?? ""}">${body}</div>${hydrationScript}${url.searchParams.get("hydrate") === "0" ? "" : '<script src="/client.js"></script>'}</body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
const levels = (page: Page) => page.locator("[data-workspace-level]:visible");
const visibleIds = (page: Page) =>
  levels(page).evaluateAll((elements) => elements.map((element) => element.getAttribute("data-workspace-main-region")));
const frames = (page: Page) =>
  page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const boxes = (page: Page) =>
  page.locator("[data-workspace-level], [data-app-workspace-resize='pane'], .k2b-app-workspace__level-head").evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return [box.x, box.y, box.width, box.height].map(Math.round);
    }),
  );
const checkFill = async (page: Page) => {
  const result = await page.evaluate(() => {
    const main = document.querySelector("[data-workspace-levels]")!.getBoundingClientRect();
    // A raised last level keeps its inset as margin; the margin box fills.
    const shown = [...document.querySelectorAll<HTMLElement>("[data-workspace-level]")]
      .filter((element) => getComputedStyle(element).display !== "none")
      .map((element) => {
        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { left: box.left - Number.parseFloat(style.marginLeft), right: box.right + Number.parseFloat(style.marginRight) };
      });
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      left: shown[0]!.left - main.left,
      right: shown.at(-1)!.right - main.right,
      gaps: shown.slice(1).map((box, index) => box.left - shown[index]!.right),
    };
  });
  expect(result.overflow).toBeLessThanOrEqual(0);
  expect(Math.abs(result.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(result.right)).toBeLessThanOrEqual(1);
  for (const gap of result.gaps) expect(Math.abs(gap)).toBeLessThanOrEqual(1);
};
for (const width of [390, 768, 1024, 1440, 1920])
  for (const selected of ["item", "sections"])
    test(`${width}px, ${selected}: SSR window, hydration and navigation`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${origin}/?level=${selected}&hydrate=0`);
        const expected =
          width < 768
            ? [selected]
            : width < 1280
              ? selected === "item"
                ? ["items", "item"]
                : ["sections", "items"]
              : ["sections", "items", "item"];
        expect(await visibleIds(page)).toEqual(expected);
        await checkFill(page);
        const before = await boxes(page);
        await page.addScriptTag({ url: `${origin}/client.js` });
        await page.waitForSelector('body[data-ready="true"]');
        await frames(page);
        expect(await boxes(page)).toEqual(before);
        const back = page.locator(".k2b-app-workspace__level-back:visible");
        const shouldBack = selected === "item" && width < 1280;
        expect(await back.count()).toBe(shouldBack ? 1 : 0);
        if (shouldBack) {
          expect(await back.evaluate((element) => element.closest("section")?.getAttribute("data-workspace-main-region"))).toBe(
            expected[0],
          );
          const box = (await back.boundingBox())!;
          expect(box.width).toBeGreaterThanOrEqual(44);
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(
            await back.evaluate((element) => element.getBoundingClientRect().top - element.closest("section")!.getBoundingClientRect().top),
          ).toBe(9); // the 8 px top inset every level shares, then the 44 px target centred in the 46 px head
          await Promise.all([page.waitForURL("**/?level=items"), back.click()]);
          expect(new URL(page.url()).searchParams.get("level")).toBe("items");
          expect(await visibleIds(page)).toEqual(width < 768 ? ["items"] : ["sections", "items"]);
          await page.goBack();
          expect(new URL(page.url()).searchParams.get("level")).toBe("item");
          expect(await visibleIds(page)).toEqual(expected);
        }
        await page.reload();
        expect(await visibleIds(page)).toEqual(expected);
        await checkFill(page);
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    }, 30000);

test("keyboard resizing, cookie restoration without a hydration shift, and double-click reset", async () => {
  const page = await browser!.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${origin}/?level=item`);
    await page.waitForSelector('body[data-ready="true"]');
    const handle = page.locator('[data-app-workspace-resize="pane"][data-workspace-panel-id="sections"]');
    const pane = page.locator('[data-workspace-level="1"]');
    const initial = (await pane.boundingBox())!.width;
    await handle.focus();
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
    expect(Number(await handle.getAttribute("aria-valuenow"))).toBe(initial + 24);
    expect((await pane.boundingBox())!.width).toBe(initial + 24);
    await page.keyboard.press("Home");
    expect(await handle.getAttribute("aria-valuenow")).toBe("200");
    await page.keyboard.press("End");
    expect(await handle.getAttribute("aria-valuenow")).toBe(await handle.getAttribute("aria-valuemax"));
    expect((await pane.boundingBox())!.width).toBe(Number(await handle.getAttribute("aria-valuemax")));
    await page.keyboard.press("Home");
    for (let i = 0; i < 18; i++) await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () => JSON.parse(decodeURIComponent(document.cookie.match(/levels_layout=([^;]+)/)![1]!)).paneWidths.sections === 344,
    );
    await page.goto(`${origin}/?level=item&hydrate=0`);
    const before = await boxes(page);
    expect((await pane.boundingBox())!.width).toBe(344);
    await page.addScriptTag({ url: `${origin}/client.js` });
    await page.waitForSelector('body[data-ready="true"]');
    await frames(page);
    expect(await boxes(page)).toEqual(before);
    expect(await handle.getAttribute("aria-valuenow")).toBe("344");
    await handle.dblclick();
    expect((await pane.boundingBox())!.width).toBe(320);
    expect(await handle.getAttribute("aria-valuenow")).toBe("320");
    await page.waitForFunction(
      () => !JSON.parse(decodeURIComponent(document.cookie.match(/levels_layout=([^;]+)/)![1]!)).paneWidths?.sections,
    );
    // Exercise a constrained three-column fit with two persisted preferences too.
    await page.context().addCookies([
      {
        name: "levels_layout",
        value: encodeURIComponent(JSON.stringify({ version: 2, paneWidths: { sections: 720, items: 640 } })),
        url: origin,
      },
    ]);
    await page.goto(`${origin}/?level=item&hydrate=0`);
    const constrained = await boxes(page);
    await page.addScriptTag({ url: `${origin}/client.js` });
    await page.waitForSelector('body[data-ready="true"]');
    await frames(page);
    expect(await boxes(page)).toEqual(constrained);
    await checkFill(page);
  } finally {
    await page.close();
  }
}, 30000);

test("at 1024px the selected middle level fills the rest and has no trailing separator", async () => {
  const page = await browser!.newPage({ viewport: { width: 1024, height: 900 } });
  try {
    await page.goto(`${origin}/?level=items`);
    await page.waitForSelector('body[data-ready="true"]');
    expect(await visibleIds(page)).toEqual(["sections", "items"]);
    expect(await page.locator('[data-app-workspace-resize="pane"][data-workspace-panel-id="items"]').isVisible()).toBe(false);
    await checkFill(page);
    const widths = await levels(page).evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
    expect(widths[1]!).toBeGreaterThan(widths[0]!);
  } finally {
    await page.close();
  }
});
