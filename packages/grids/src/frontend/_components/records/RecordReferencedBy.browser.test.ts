import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { Browser, Page } from "playwright";
import { launchBrowser, settled } from "../../../../../ui/test/browser";
// Brings the harness's `window.mountLinks` into scope for the page scripts below.
import type {} from "./RecordReferencedBy.browser-harness";

// Whether the record's links move when the reverse relations arrive is a question of layout, so the real section runs
// in a browser. The server answers the reverse relations late on purpose: a first page that the page did not bring
// along would arrive after the outgoing rows and push them down.
const buildHarness = async (): Promise<string> => {
  const ui = new URL("../../../../../ui/", import.meta.url).pathname;
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", ui));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", ui))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", ui))).default;
  const build = await Bun.build({
    entrypoints: [new URL("./RecordReferencedBy.browser-harness.tsx", import.meta.url).pathname],
    target: "browser",
    format: "iife",
    conditions: ["browser"],
    plugins: [
      {
        name: "solid-grids-links-test",
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
  if (!build.success) throw new AggregateError(build.logs, "Grids links harness build failed");
  return build.outputs[0]!.text();
};

const buildCss = async (entry: string): Promise<string> => {
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../../../cloud/", import.meta.url).pathname)))
    .default;
  const build = await Bun.build({ entrypoints: [entry], plugins: [tailwind] });
  if (!build.success) throw new AggregateError(build.logs, `Could not compile ${entry}`);
  return build.outputs[0]!.text();
};

const LATE_MS = 400;
const harness = await buildHarness();
const uiDist = resolve(import.meta.dir, "../../../../../ui/dist");
const css =
  (await buildCss(resolve(import.meta.dir, "../../../../../../styles.css"))) +
  (await buildCss(resolve(import.meta.dir, "../../../styles/app.css")));
const reverseRequests: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/harness.js") return new Response(harness, { headers: { "Content-Type": "text/javascript; charset=utf-8" } });
    if (pathname === "/styles.css") return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8" } });
    if (pathname.startsWith("/ui-dist/")) return new Response(Bun.file(resolve(uiDist, pathname.slice("/ui-dist/".length))));
    if (pathname.endsWith("/referenced-by")) {
      reverseRequests.push(pathname);
      await Bun.sleep(LATE_MS);
      return Response.json({
        items: [101, 102].map((id) => ({
          sourceTableId: "TABLE2",
          sourceTableName: "Ausleihen",
          sourceRecordId: `REC${id}`,
          sourceRecordLabel: `Ausleihe ${id}`,
          relationFieldId: "FIELD2",
          relationFieldName: "Lagerort",
        })),
        nextCursor: null,
      });
    }
    return new Response(
      '<!doctype html><html class="light" lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/ui-dist/plex.css"><link rel="stylesheet" href="/ui-dist/tabler.css"></head><body class="k2b-ui" style="margin:0">' +
        '<div id="root" style="width:min(25rem,100%);height:100dvh;display:flex;flex-direction:column"></div><script src="/harness.js"></script></body></html>',
      { headers: { "Content-Type": "text/html" } },
    );
  },
});

let browser: Browser;
beforeAll(async () => {
  browser = await launchBrowser();
}, 30_000);
afterAll(async () => {
  await browser?.close();
  server.stop(true);
});

const outgoingTop = (page: Page) =>
  page.evaluate(() => {
    const row = Array.from(document.querySelectorAll("a.k2b-detail-panel__action")).find((link) =>
      link.textContent?.includes("Kategorie · Kameras"),
    );
    return row ? Math.round(row.getBoundingClientRect().top) : null;
  });

for (const width of [1440, 390])
  test(`the record's outgoing links keep their place when the reverse relations are known at ${width}px`, async () => {
    reverseRequests.length = 0;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(server.url.href);
      await page.waitForFunction(() => typeof window.mountLinks === "function");
      await page.evaluate(() => window.mountLinks("server"));
      await settled(page);
      const before = await outgoingTop(page);
      expect(before).not.toBeNull();
      // Both directions are there in the first paint.
      expect(await page.getByText("Verlinkt von 2").count()).toBe(1);
      expect(await page.getByText("Verweist auf 2").count()).toBe(1);
      // Longer than the late answer would take: nothing may arrive and push the rows down.
      await page.waitForTimeout(LATE_MS * 2);
      await settled(page);
      expect(await outgoingTop(page)).toBe(before);
      expect(reverseRequests).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

for (const width of [1440, 390])
  test(`opening another record keeps the outgoing links where they first appear at ${width}px`, async () => {
    reverseRequests.length = 0;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.goto(server.url.href);
      await page.waitForFunction(() => typeof window.mountLinks === "function");
      await page.evaluate(() => window.mountLinks("late-detail"));
      // While the record's detail loads, the section holds its place without rows.
      await settled(page);
      expect(await page.getByText("Verknüpfungen", { exact: true }).count()).toBeGreaterThan(0);
      expect(await outgoingTop(page)).toBeNull();
      const first = await page.waitForFunction(() => {
        const row = Array.from(document.querySelectorAll("a.k2b-detail-panel__action")).find((link) =>
          link.textContent?.includes("Kategorie · Kameras"),
        );
        return row ? Math.round(row.getBoundingClientRect().top) : false;
      });
      const appeared = (await first.jsonValue()) as number;
      // Both directions arrive together, and nothing comes later to push the rows down.
      expect(await page.getByText("Verlinkt von 2").count()).toBe(1);
      await page.waitForTimeout(LATE_MS * 2);
      await settled(page);
      expect(await outgoingTop(page)).toBe(appeared);
      expect(reverseRequests).toEqual([]);
    } finally {
      await page.close();
    }
  }, 30_000);

test("without a page from the server, the section reads the reverse relations itself", async () => {
  reverseRequests.length = 0;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(server.url.href);
    await page.waitForFunction(() => typeof window.mountLinks === "function");
    await page.evaluate(() => window.mountLinks("browser"));
    await page.getByText("Verlinkt von 2").waitFor();
    await settled(page);
    expect(reverseRequests).toHaveLength(1);
    expect(await page.locator("a.k2b-detail-panel__action", { hasText: "Ausleihe 101" }).count()).toBe(1);
  } finally {
    await page.close();
  }
}, 30_000);
