import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors } from "../../../ui/test/browser";
import { fixture as assets } from "./Pagination.browser-fixture";
import type { DirectoryView, WorkspaceSnapshot } from "./workspace-state";

// The storage sidebar stays exactly where the person left it while they move through folders: on every
// frame of a full load and of each in-page navigation, in the tree and in the list. Files once restored
// its own fixed widths over the saved layout, so the sidebar shrank for a frame and snapped back.
const ui = new URL("../../../ui/", import.meta.url).pathname;
const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
const build = await Bun.build({
  entrypoints: [new URL("./SidebarFrames.browser-harness.tsx", import.meta.url).pathname],
  target: "browser",
  format: "iife",
  conditions: ["browser"],
  plugins: [
    {
      name: "solid-sidebar-frames-test",
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
if (!build.success) throw new AggregateError(build.logs, "Sidebar frames harness build failed");
const harness = await build.outputs[0]!.text();

const base: DirectoryView["base"] = {
  id: "demo",
  name: "Projektatelier",
  area: "cloud",
  kind: "groups",
  status: "existing",
  reason: null,
  indexEnabled: false,
  versioningEnabled: false,
};
const tree: Record<string, string[]> = {
  "": ["Alpha", "Beta"],
  Alpha: ["Unter"],
  "Alpha/Unter": ["Tief"],
  "Alpha/Unter/Tief": [],
  Beta: [],
};
const entry = (path: string, name: string, directory: boolean) => ({
  name,
  path: path ? `${path}/${name}` : name,
  directory,
  size: directory ? 0 : 1200,
  modified: "2026-11-07T12:00:00Z",
  actions: { read: true, write: false, move: false, share: false },
});
const directory = (path: string, foldersOnly = false): DirectoryView => ({
  base,
  path,
  next: null,
  loadedPages: 1,
  items: [
    ...(tree[path] ?? []).map((name) => entry(path, name, true)),
    ...(foldersOnly ? [] : ["Notiz.md", "Plan.pdf"].map((name) => entry(path, name, false))),
  ],
});
const fixture = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";
  // Slow enough that every navigation paints its pending state.
  if (url.pathname.startsWith("/api/")) await Bun.sleep(80);
  if (url.pathname === "/sidebar-harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript" } });
  if (url.pathname === "/api/filesv2/bases") return Response.json({ items: [base], issues: [], editor: null });
  if (url.pathname === "/api/filesv2/bases/demo/entries")
    return Response.json(directory(path, url.searchParams.get("type") === "directories"));
  if (url.pathname === "/app/filesv2") {
    const initial: WorkspaceSnapshot = {
      source: url.pathname + url.search,
      directory: directory(path),
      selectedId: base.id,
      bases: { items: [base], issues: [], editor: null },
      errorCode: null,
      now: "2026-11-07T12:00:00Z",
    };
    const saved = request.headers.get("x-saved-layout") ?? "null";
    const page = await (await assets(new Request(new URL("/app/filesv2", url)))).text();
    const html = page
      .replace(
        /<script id="snapshot"[^]*?<\/script>/,
        () =>
          `<script id="snapshot" type="application/json">${JSON.stringify(initial)}</script><script id="saved-layout" type="application/json">${saved}</script>`,
      )
      .replace('src="/harness.js"', 'src="/sidebar-harness.js"');
    return new Response(html, { headers: { "Content-Type": "text/html" } });
  }
  return assets(request);
};

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: fixture });
  browser = await launchBrowser();
}, 30000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

type Frame = { url: string; sidebar: number; content: number };
// Installed before any script: the sidebar's width and the main column's left edge on every animation frame.
const record = () => {
  const frames: Frame[] = [];
  (window as unknown as { sidebarFrames: Frame[] }).sidebarFrames = frames;
  const tick = () => {
    const sidebar = document.querySelector(".k2b-app-workspace__sidebar")?.getBoundingClientRect();
    const content = document.querySelector(".k2b-app-workspace__content")?.getBoundingClientRect();
    if (sidebar && content) frames.push({ url: location.search, sidebar: sidebar.width, content: content.left });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
const takeFrames = (tab: Page) => tab.evaluate(() => (window as unknown as { sidebarFrames: Frame[] }).sidebarFrames.splice(0));
const settled = async (tab: Page, path: string) => {
  await tab.waitForFunction(
    (path) =>
      (new URLSearchParams(location.search).get("path") ?? "") === path &&
      !!document.querySelector(".filesv2-list__row") &&
      !document.querySelector('[aria-busy="true"], .filesv2-nav-spinner'),
    path,
  );
  await tab.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
};

for (const [width, saved] of [
  [1440, null],
  [1440, { version: 2, sidebarWidth: 300 }],
  [1280, { version: 2, sidebarWidth: 220 }],
] as const)
  test(`${width}px, saved ${saved?.sidebarWidth ?? "nothing"}: full loads and folder changes keep the sidebar still on every frame`, async () => {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
      extraHTTPHeaders: { "x-saved-layout": JSON.stringify(saved) },
    });
    const tab = await context.newPage();
    const errors = pageErrors(tab);
    await tab.addInitScript(record);
    const still = { sidebar: saved?.sidebarWidth ?? 248, content: (saved?.sidebarWidth ?? 248) + 1 };
    const moved = (frames: Frame[]) => frames.filter((frame) => frame.sidebar !== still.sidebar || frame.content !== still.content);
    try {
      for (const path of ["Alpha/Unter", ""]) {
        await tab.goto(new URL(`app/filesv2?base=demo${path ? `&path=${encodeURIComponent(path)}` : ""}`, server.url).href);
        await settled(tab, path);
        const frames = await takeFrames(tab);
        expect(frames.length).toBeGreaterThan(0);
        expect(moved(frames)).toEqual([]);
      }
      // The inspector keeps Files' own default too, until a saved width replaces it.
      expect(
        await tab
          .locator(".k2b-app-workspace")
          .evaluate((root) => getComputedStyle(root).getPropertyValue("--k2b-workspace-detail-filesv2-inspector-width")),
      ).toBe("400px");
      const row = (name: string) => tab.locator(".filesv2-list__row", { hasText: name }).first();
      const treeRow = (name: string) => tab.locator(".k2b-app-workspace__nav-tree-row", { hasText: name }).first();
      for (const [step, path] of [
        [() => row("Alpha").dblclick(), "Alpha"],
        [() => row("Unter").dblclick(), "Alpha/Unter"],
        [() => row("Tief").dblclick(), "Alpha/Unter/Tief"],
        [() => treeRow("Beta").click(), "Beta"],
        [() => treeRow("Alpha").click(), "Alpha"],
        [() => treeRow("Unter").click(), "Alpha/Unter"],
        [() => treeRow("Projektatelier").click(), ""],
      ] as const) {
        await step();
        await settled(tab, path);
        expect(moved(await takeFrames(tab))).toEqual([]);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 60000);
