import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const directory = mkdtempSync(resolve(tmpdir(), "k2b-ui-head-pane-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const fixturePath = resolve(import.meta.dir, "workspace-head-pane.fixture.tsx");
// Keep real JSX prop getters: preconstructed elements would hide double slot reads.
const fixture = (entry: string) => `
import { createSignal, onCleanup, onMount } from "solid-js";
import { AppWorkspace, DetailPanel, PageTrailProvider, appWorkspaceDetailElementId } from ${JSON.stringify(entry)};
export function Fixture(props) {
  const [pane, setPane] = createSignal(props.reader ? "main" : "list");
  const [details, setDetails] = createSignal(false);
  const choose = () => { history.pushState(null, "", "?reader=1"); setPane("main"); };
  onMount(() => { const restore = () => setPane(new URLSearchParams(location.search).has("reader") ? "main" : "list"); window.addEventListener("popstate", restore); onCleanup(() => window.removeEventListener("popstate", restore)); });
  const main = () => <AppWorkspace.Main mobilePane={pane()}>
    {!props.unsplit && <AppWorkspace.MainPane id="list"><button onClick={choose}>Open record</button></AppWorkspace.MainPane>}
    <div id="reader"><button onClick={() => history.back()}>Back to list</button><h1>Record title</h1>
      <button id="reader-details" aria-controls={appWorkspaceDetailElementId("record")} aria-expanded={details()} onClick={() => setDetails(!details())}>Record details</button>
      {props.nested && <AppWorkspace class="nested"><AppWorkspace.Head actions={<button>Nested action</button>} /><AppWorkspace.Content><AppWorkspace.Main>Nested content</AppWorkspace.Main></AppWorkspace.Content></AppWorkspace>}
    </div>
  </AppWorkspace.Main>;
  return <PageTrailProvider trail={{title:"Records",ancestors:[]}}><AppWorkspace class="outer">
    <AppWorkspace.Head mobilePane={props.unbound ? undefined : "list"} views={props.title ? <span id="pane-title">Records</span> : undefined} actions={<button>List action</button>} />
    <AppWorkspace.Content>
      {props.island ? <solid-island style="display:contents">{main()}</solid-island> : main()}
      <AppWorkspace.Detail id="record" open={details()} available={!props.unavailable} onOpen={() => setDetails(true)} onClose={() => setDetails(false)}>
        <DetailPanel><DetailPanel.Header title="Record information" onClose={() => setDetails(false)} /><DetailPanel.Body>Information</DetailPanel.Body></DetailPanel>
      </AppWorkspace.Detail>
    </AppWorkspace.Content>
  </AppWorkspace></PageTrailProvider>;
}
`;
const serverEntry = resolve(import.meta.dir, "workspace-head-pane.server-fixture.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [serverEntry]: `import { createComponent } from "solid-js";
import { renderToString, generateHydrationScript } from "solid-js/web";
import { Fixture } from "./workspace-head-pane.fixture";
export const render = (options = {}) => renderToString(() => createComponent(Fixture, options));
export const hydrationScript = generateHydrationScript();`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [
    {
      name: "head-pane-ssr",
      setup(builder) {
        builder.onResolve({ filter: /workspace-head-pane\.fixture$/ }, () => ({ path: fixturePath, namespace: "head-fixture" }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "head-fixture" }, async ({ path }) => {
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
if (!serverBuild.success) throw new AggregateError(serverBuild.logs, "Could not bundle head SSR fixture");
const modulePath = resolve(directory, "server.mjs");
writeFileSync(modulePath, await serverBuild.outputs[0]!.text());
const { render, hydrationScript }: { render: (options: Record<string, boolean>) => string; hydrationScript: string } = await import(
  modulePath
);
const clientEntry = resolve(import.meta.dir, "workspace-head-pane.client-fixture.ts");
const clientBuild = await Bun.build({
  entrypoints: [clientEntry],
  target: "browser",
  format: "iife",
  files: {
    [clientEntry]: `import { createComponent } from "solid-js";
import { hydrate } from "solid-js/web";
import { Fixture } from "./workspace-head-pane.fixture";
hydrate(() => createComponent(Fixture, JSON.parse(document.body.dataset.options)), document.getElementById("app"));
document.body.dataset.ready = "true";`,
  },
  plugins: [
    {
      name: "head-pane-dom",
      setup(builder) {
        builder.onResolve({ filter: /workspace-head-pane\.fixture$/ }, () => ({ path: fixturePath, namespace: "head-fixture" }));
        builder.onLoad({ filter: /\.tsx$/, namespace: "head-fixture" }, async ({ path }) => {
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
if (!clientBuild.success) throw new AggregateError(clientBuild.logs, "Could not bundle head hydration fixture");
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
      if (new URL(request.url).pathname === "/client.js") {
        return new Response(script, { headers: { "Content-Type": "application/javascript" } });
      }
      const params = new URL(request.url).searchParams;
      const options = Object.fromEntries(["reader", "unbound", "unsplit", "nested", "island", "title", "unavailable"].map((key) => [key, params.has(key)]));
      return new Response(
        `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body class="k2b-ui" style="margin:0" data-options='${JSON.stringify(options)}'><div id="app" style="container:k2b-app-area / inline-size;height:900px">${render(options)}</div>${hydrationScript}</body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
}, 30_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    server?.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});

const geometry = (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector(".outer")!;
    const head = root.querySelector(":scope > .k2b-app-workspace__head")!;
    const content = root.querySelector(":scope > .k2b-app-workspace__content")!;
    const toggle = content.querySelector("[data-app-workspace-detail-toggle]")!;
    return {
      head: head.getBoundingClientRect().height,
      top: content.getBoundingClientRect().top - root.getBoundingClientRect().top - root.clientTop,
      toggle: toggle.getClientRects().length > 0,
      nested: root.querySelector(".nested > .k2b-app-workspace__head")?.getBoundingClientRect().height,
    };
  });

for (const width of [390, 768, 834]) {
  for (const island of [false, true]) {
    test(`pane-bound head: SSR and hydration at ${width}px, island=${island}`, async () => {
      const page = await browser!.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(`${origin}?reader=1&nested=1${island ? "&island=1" : ""}`);
        await settled(page);
        const before = await geometry(page);
        expect(before.head === 0).toBe(width < 768);
        expect(before.toggle).toBe(width >= 768);
        if (width < 768) expect(before.top).toBe(0);
        expect(before.nested).toBeGreaterThan(0);
        await page.addScriptTag({ url: `${origin}/client.js` });
        await page.locator('body[data-ready="true"]').waitFor();
        await settled(page);
        expect(await geometry(page)).toEqual(before);
        expect(errors).toEqual([]);
        if (width < 768) {
          await page.getByRole("button", { name: "Record details", exact: true }).focus();
          await page.keyboard.press("Enter");
          await page.getByRole("heading", { name: "Record information" }).waitFor();
          await page.keyboard.press("Escape");
          await settled(page);
          expect(await page.locator("#reader-details").evaluate((e) => e === document.activeElement)).toBe(true);
          expect((await geometry(page)).head).toBe(0);
        }
      } finally {
        await page.close();
      }
    }, 30_000);
  }
}

for (const mode of ["unbound", "unsplit"]) {
  test(`phone ${mode} preserves the head`, async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.goto(`${origin}?reader=1&${mode}=1`);
      await settled(page);
      expect((await geometry(page)).head).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  });
}

test("phone selection, Back and reload use the existing pane state", async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: "reduce" });
  try {
    await page.goto(origin);
    await settled(page);
    expect((await geometry(page)).head).toBeGreaterThan(0);
    await page.addScriptTag({ url: `${origin}/client.js` });
    await page.getByRole("button", { name: "Open record" }).click();
    await settled(page);
    expect((await geometry(page)).head).toBe(0);
    await page.getByRole("button", { name: "Back to list" }).click();
    await page.waitForFunction(() => !new URLSearchParams(location.search).has("reader"));
    await settled(page);
    expect((await geometry(page)).head).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Open record" }).click();
    await page.reload();
    await settled(page);
    expect((await geometry(page)).head).toBe(0);
  } finally {
    await page.close();
  }
}, 30_000);

for (const island of [false, true]) {
  test(`phone list head without an object: a title keeps the inset, no Details, island=${island}`, async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: "reduce" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const list = () =>
      page.evaluate(() => {
        const head = document.querySelector(".outer > .k2b-app-workspace__head")!;
        const title = document.getElementById("pane-title")!;
        const range = document.createRange();
        range.selectNodeContents(title);
        const actions = head.querySelector(".k2b-app-workspace__head-actions")!.getBoundingClientRect();
        return {
          titleInset: range.getBoundingClientRect().left - head.getBoundingClientRect().left,
          endInset: head.getBoundingClientRect().right - actions.right,
          toggle: document.querySelector(".outer [data-app-workspace-detail-toggle]")!.getClientRects().length > 0,
        };
      });
    try {
      await page.goto(`${origin}?title=1&unavailable=1${island ? "&island=1" : ""}`);
      await settled(page);
      const before = await list();
      // The head's own 1 rem inset, as the view strip and filter row keep it.
      expect(before).toEqual({ titleInset: 16, endInset: 16, toggle: false });
      await page.addScriptTag({ url: `${origin}/client.js` });
      await page.locator('body[data-ready="true"]').waitFor();
      await settled(page);
      expect(await list()).toEqual(before);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
}

// Only an unavailable control leaves a split list head; an available one, an
// unbound head and an unsplit Main keep their only shared way to Details.
for (const query of ["title=1", "unbound=1&unavailable=1", "unsplit=1&unavailable=1"]) {
  test(`phone head keeps the shared Details control: ${query}`, async () => {
    const page = await browser!.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: "reduce" });
    try {
      await page.goto(`${origin}?${query}`);
      await settled(page);
      expect((await geometry(page)).toggle).toBe(true);
    } finally {
      await page.close();
    }
  });
}
