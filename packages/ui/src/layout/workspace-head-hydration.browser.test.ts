import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformAsync } from "@babel/core";
import typescript from "@babel/preset-typescript";
import solid from "babel-preset-solid";
import type { Browser, Page } from "playwright";
import { launchBrowser, pageErrors, settled } from "../../test/browser";

const ui = resolve(import.meta.dir, "../..");
const directory = mkdtempSync(resolve(tmpdir(), "k2b-ui-head-hydration-"));
process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
const fixturePath = resolve(import.meta.dir, "workspace-head-hydration.fixture.tsx");
// Keep real JSX prop getters: preconstructed elements would hide double slot reads.
const fixture = (entry: string) => `
import { AppWorkspace, ViewTabs, FilterChip, IconButton, PageTrailProvider } from ${JSON.stringify(entry)};
export function Fixture(props: { stacked?: boolean }) {
  const views = Array.from({ length: 6 }, (_, index) => ({ id: String(index + 1), label: "View " + (index + 1), href: "?view=" + (index + 1) }));
  const options = [{ options: [{ value: "open", label: "Open" }] }];
  return <PageTrailProvider trail={{ title: "Project", ancestors: [{ title: "Projects", href: "/projects" }] }}>
    <AppWorkspace mobileSurface={props.stacked ? "flush" : undefined}>
      <AppWorkspace.Sidebar label="Navigation" mobile={props.stacked ? "stacked" : undefined}><AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarBody><AppWorkspace.SidebarItem href="/project" active>Project</AppWorkspace.SidebarItem></AppWorkspace.SidebarBody>
      </AppWorkspace.SidebarDesktop></AppWorkspace.Sidebar>
      <AppWorkspace.Head
        views={<ViewTabs label="Views" items={views} current="2" />}
        filters={<>
          <FilterChip label="Status" icon="ti ti-filter" options={options} value={["open"]} onValueChange={() => {}} showValue />
          <FilterChip label="Owner" icon="ti ti-user" options={options} value={[]} onValueChange={() => {}} showValue />
        </>}
        filtered count={0} resetHref="?view=2"
        actions={<IconButton label="Refresh"><i class="ti ti-refresh" aria-hidden="true" /></IconButton>}
        primary={{ label: "New task", icon: "ti ti-plus", href: "/new" }}
      />
      <AppWorkspace.Content><AppWorkspace.Main>Main content</AppWorkspace.Main></AppWorkspace.Content>
    </AppWorkspace>
  </PageTrailProvider>;
}
`;
const serverEntry = resolve(import.meta.dir, "workspace-head-hydration.server-fixture.ts");
const serverBuild = await Bun.build({
  entrypoints: [serverEntry],
  files: {
    [serverEntry]: `import { createComponent } from "solid-js";
import { renderToString, generateHydrationScript } from "solid-js/web";
import { Fixture } from "./workspace-head-hydration.fixture";
export const render = (stacked = false) => renderToString(() => createComponent(Fixture, { stacked }));
export const hydrationScript = generateHydrationScript();`,
  },
  target: "node",
  conditions: ["node"],
  plugins: [
    {
      name: "head-hydration-ssr",
      setup(builder) {
        builder.onResolve({ filter: /workspace-head-hydration\.fixture$/ }, () => ({ path: fixturePath, namespace: "head-fixture" }));
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
const { render, hydrationScript }: { render: (stacked?: boolean) => string; hydrationScript: string } = await import(modulePath);
const clientEntry = resolve(import.meta.dir, "workspace-head-hydration.client-fixture.ts");
const clientBuild = await Bun.build({
  entrypoints: [clientEntry],
  target: "browser",
  format: "iife",
  files: {
    [clientEntry]: `import { createComponent } from "solid-js";
import { hydrate } from "solid-js/web";
import { Fixture } from "./workspace-head-hydration.fixture";
hydrate(() => createComponent(Fixture, { stacked: document.body.dataset.stacked === "true" }), document.getElementById("app"));
document.body.dataset.ready = "true";`,
  },
  plugins: [
    {
      name: "head-hydration-dom",
      setup(builder) {
        builder.onResolve({ filter: /workspace-head-hydration\.fixture$/ }, () => ({ path: fixturePath, namespace: "head-fixture" }));
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
      const stacked = new URL(request.url).searchParams.has("stacked");
      return new Response(
        `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body class="k2b-ui" style="margin:0" data-stacked="${stacked}"><div id="app" style="container:k2b-app-area / inline-size;height:900px">${render(stacked)}</div>${hydrationScript}</body></html>`,
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
const boxes = (page: Page) =>
  page
    .locator(
      ".k2b-app-workspace__head, .k2b-app-workspace__head-lead, .k2b-page-title, .k2b-app-workspace__head-views, .k2b-view-tabs, .k2b-view-tabs__item > a, .k2b-view-tabs__more-trigger, .k2b-app-workspace__head-filters, .k2b-filter-chip, .k2b-app-workspace__head-reset, .k2b-app-workspace__head-count, .k2b-app-workspace__head-actions, .k2b-app-workspace__head-actions > button, [data-workspace-primary]",
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );

describe("workspace head hydration", () => {
  test("reuses every SSR head part without moving it and opens More after hydration", async () => {
    const page = await browser!.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const errors = pageErrors(page);
    const hydrationMessages: string[] = [];
    page.on("console", (message) => {
      if ((message.type() === "error" || message.type() === "warning") && /hydrat/i.test(message.text()))
        hydrationMessages.push(message.text());
    });
    try {
      await page.goto(origin);
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await settled(page);
      const before = await boxes(page);
      await page.addScriptTag({ url: `${origin}/client.js` });
      expect(errors).toEqual([]);
      await page.waitForSelector('body[data-ready="true"]');
      await settled(page);
      expect(await boxes(page)).toEqual(before);
      for (const [selector, count] of [
        [".k2b-view-tabs", 1],
        [".k2b-filter-chip", 2],
        ["[data-workspace-primary]", 1],
        [".k2b-app-workspace__head-count", 1],
        [".k2b-app-workspace__head-reset", 1],
        [".k2b-app-workspace__head-actions", 1],
        [".k2b-view-tabs__more-trigger", 1],
      ] as const) {
        expect(await page.locator(selector).count(), selector).toBe(count);
      }
      expect(await page.locator(".k2b-view-tabs__item > a").evaluateAll((links) => links.map((link) => link.getAttribute("href")))).toEqual(
        ["?view=1", "?view=2", "?view=3", "?view=4", "?view=5"],
      );
      expect(await page.locator('.k2b-view-tabs [aria-current="page"]').getAttribute("href")).toBe("?view=2");
      expect(await page.locator(".k2b-filter-chip").allTextContents()).toEqual(["Status: Open", "Owner"]);
      expect(await page.locator('.k2b-filter-chip[data-active="true"]').count()).toBe(1);
      expect(await page.locator(".k2b-app-workspace__head-reset").textContent()).toBe("Reset");
      expect(await page.locator(".k2b-app-workspace__head-count").textContent()).toBe("0");
      expect(await page.getByRole("button", { name: "Refresh", exact: true }).count()).toBe(1);
      expect(await page.getByRole("link", { name: "New task", exact: true }).count()).toBe(1);
      await page.locator(".k2b-view-tabs__more-trigger").click();
      const menu = page.getByRole("menu", { name: "More views" });
      await menu.waitFor({ state: "visible" });
      expect(await menu.getByRole("menuitem").evaluateAll((items) => items.map((item) => item.getAttribute("href")))).toEqual(["?view=6"]);
      expect(errors).toEqual([]);
      expect(hydrationMessages).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
});

for (const width of [390, 834, 1440]) {
  test(`stacked objects and explicit head hydrate once at ${width}px`, async () => {
    const page = await browser!.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    const errors = pageErrors(page);
    try {
      await page.goto(`${origin}?stacked=1`);
      await settled(page);
      const before = await boxes(page);
      const sidebar = page.locator(".k2b-app-workspace__sidebar");
      const head = page.locator(".k2b-app-workspace__head");
      expect(
        await sidebar.evaluate(
          (nav) => !!(nav.compareDocumentPosition(document.querySelector(".k2b-app-workspace__head")!) & Node.DOCUMENT_POSITION_FOLLOWING),
        ),
      ).toBe(true);
      if (width === 390) {
        const navBox = (await sidebar.boundingBox())!;
        expect((await head.boundingBox())!.y).toBeGreaterThanOrEqual(navBox.y + navBox.height);
      }
      await page.evaluate(() => Reflect.set(window, "originalHead", document.querySelector(".k2b-app-workspace__head")));
      await page.addScriptTag({ url: `${origin}/client.js` });
      await page.waitForSelector('body[data-ready="true"]');
      await settled(page);
      expect(await page.evaluate(() => Reflect.get(window, "originalHead") === document.querySelector(".k2b-app-workspace__head"))).toBe(
        true,
      );
      expect(await boxes(page)).toEqual(before);
      if (width === 390) {
        await page.getByRole("link", { name: "Project", exact: true }).focus();
        await page.keyboard.press("Tab");
        expect(
          await page.getByRole("button", { name: "All Navigation", exact: true }).evaluate((el) => el === document.activeElement),
        ).toBe(true);
        await page.keyboard.press("Tab");
        expect(await page.locator(".k2b-app-workspace__head").evaluate((el) => el.contains(document.activeElement))).toBe(true);
      }
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);
}
