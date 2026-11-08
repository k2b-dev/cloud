import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type CodePageTree, validateCodePage } from "@k2b/cloud/code";
import { createConfig } from "@k2b/ssr";
import tailwind from "bun-plugin-tailwind";
import type { Browser, Page } from "playwright";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { launchBrowser, pageErrors, settled } from "../../../ui/test/browser";
import { CODE_NEWSLETTER_DEMO_SOURCE } from "./page.newsletter-demo";
import { codePageFixture } from "./page.test-fixture";
import { buildCodePage } from "./page.test-source";

// The real renderer with the real stylesheet: the server's page, the island that replaces it, and every request it
// sends. A fake event source stands in for platform events.
const root = mkdtempSync(join(tmpdir(), "core-code-page-browser-"));
Bun.plugin(createConfig({ dev: true, rootDir: root }).plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { default: PageTree } = await import("./PageTree.island");
const { buildFontAssets } = await import("../../scripts/font-assets");
const { buildTablerIconAssets } = await import("../../scripts/tabler-assets");
const publicDir = join(root, "public");
const codeId = "c_page";
const csrf = "session-bound";
/** Light screenshots for review; the directory is kept. */
const shots = process.env.CODE_PAGE_SHOTS;

const check = (tree: unknown) => validateCodePage(tree, codeId);
const home = check(codePageFixture);
const withChildren = (tree: CodePageTree, children: CodePageTree["children"]) => check({ ...tree, children });
const itemPage = check({
  version: 1,
  kind: "Page",
  title: "Chair",
  children: [{ kind: "Detail", title: "Chair", items: [{ label: "Code", value: "W-1" }] }],
});

type Post = { path: string; fields: Record<string, string>; tree: string | null };
type Reply = { delay?: number; response: () => Response };
const state = {
  trees: new Map<string, CodePageTree>(),
  posts: [] as Post[],
  replies: [] as Reply[],
  treeLoads: 0,
  treeDelay: 0,
};
const treeResponse = (tree: CodePageTree) => Response.json({ tree, csrf }, { headers: { "X-Code-Page": "tree" } });
const failure = (status: number, code: string) => Response.json({ code }, { status });

let script = "";
let css = "";
let server: ReturnType<typeof Bun.serve>;
let browser: Browser;

const documentFor = (tree: CodePageTree) => {
  const body = renderToString(() => createComponent(PageTree, { tree, codeId, csrf, locale: "en", timeZone: "UTC" }));
  const props = JSON.stringify({ tree, codeId, csrf, locale: "en", timeZone: "UTC" }).replaceAll("<", "\\u003c");
  return (
    `<!doctype html><html lang="en" class="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${tree.title} · Cloud</title><link rel="stylesheet" href="/public/fonts.css"><link rel="stylesheet" href="/public/tabler-icons.css">` +
    `<style>${css}</style></head><body class="k2b-ui"><div id="app">${body}</div>` +
    `<script type="application/json" id="props">${props}</script><script src="/client.js"></script></body></html>`
  );
};

beforeAll(async () => {
  const ui = resolve(import.meta.dir, "../../../ui");
  const { transformAsync } = await import(Bun.resolveSync("@babel/core", `${ui}/`));
  const typescript = (await import(Bun.resolveSync("@babel/preset-typescript", `${ui}/`))).default;
  const solid = (await import(Bun.resolveSync("babel-preset-solid", `${ui}/`))).default;
  // Lives only in memory; its path makes relative imports resolve from this folder.
  const entry = resolve(import.meta.dir, "page.browser-entry.ts");
  const fixture = `import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import Page from "./PageTree.island";
const listeners = new Set();
const events = { subscribe(types, onEvent) { window.followed = types; listeners.add(onEvent); return () => listeners.delete(onEvent); } };
window.emit = () => listeners.forEach((listener) => listener());
window.mount = () => {
  const app = document.getElementById("app");
  const props = JSON.parse(document.getElementById("props").textContent);
  app.textContent = "";
  render(() => createComponent(Page, { ...props, events }), app);
};
if (!location.search.includes("hold")) window.mount();`;
  const bundle = await Bun.build({
    entrypoints: [entry],
    files: { [entry]: fixture },
    target: "browser",
    conditions: ["browser"],
    format: "iife",
    plugins: [
      {
        name: "code-page-dom",
        setup(builder) {
          builder.onLoad({ filter: /\.tsx$/ }, async ({ path }) => {
            const transformed = await transformAsync(await Bun.file(path).text(), {
              filename: path,
              babelrc: false,
              configFile: false,
              presets: [typescript, [solid, { generate: "dom", hydratable: false }]],
            });
            return { contents: transformed.code, loader: "js" };
          });
        },
      },
    ],
  });
  if (!bundle.success) throw new AggregateError(bundle.logs, "Could not compile the Code page");
  script = await bundle.outputs[0]!.text();
  const styles = [resolve(import.meta.dir, "../styles/app.css"), resolve(import.meta.dir, "../../../../styles.css")];
  const built = await Promise.all(styles.map((path) => Bun.build({ entrypoints: [path], plugins: [tailwind] })));
  for (const build of built) if (!build.success) throw new AggregateError(build.logs, "Could not compile the stylesheets.");
  const [appCss, globalCss] = await Promise.all(built.map((build) => build.outputs[0]!.text()));
  css = ["@layer properties, theme, base, components, utilities;", appCss, globalCss].join("\n");
  await buildFontAssets(publicDir);
  await buildTablerIconAssets(publicDir);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/public/")) return new Response(Bun.file(join(root, url.pathname)));
      if (url.pathname === "/client.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
      const path = url.pathname.slice(`/code/${codeId}`.length) || "/";
      if (request.method === "POST") {
        state.posts.push({
          path: url.pathname,
          fields: Object.fromEntries(new URLSearchParams(await request.text())),
          tree: request.headers.get("X-Code-Page"),
        });
        const reply = state.replies.shift() ?? { response: () => treeResponse(state.trees.get("/")!) };
        if (reply.delay) await Bun.sleep(reply.delay);
        return reply.response();
      }
      const tree = state.trees.get(path);
      if (!tree) return failure(404, "code_route_not_found");
      if (request.headers.get("X-Code-Page") === "tree") {
        state.treeLoads++;
        if (state.treeDelay) await Bun.sleep(state.treeDelay);
        return treeResponse(tree);
      }
      return new Response(documentFor(tree), { headers: { "Content-Type": "text/html" } });
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});

/** The Newsletter dashboard of the chart showcase, built from Code source. */
const newsletter = await buildCodePage(CODE_NEWSLETTER_DEMO_SOURCE, codeId);
const reset = () => {
  state.trees = new Map([
    ["/", home],
    ["/newsletter", newsletter],
    ["/items/W-1", itemPage],
  ]);
  state.posts = [];
  state.replies = [];
  state.treeLoads = 0;
  state.treeDelay = 0;
};

type Camera = "code" | "denied" | null;
async function open(width: number, options: { hold?: boolean; camera?: Camera; path?: string } = {}) {
  reset();
  const phone = width < 600;
  const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, isMobile: phone, hasTouch: phone });
  if (options.camera)
    await context.addInitScript((camera: Exclude<Camera, null>) => {
      // A camera that films a white picture and a detector that reads one code from it, as on Chrome for Android.
      Object.defineProperty(globalThis, "BarcodeDetector", {
        configurable: true,
        value: class {
          static async getSupportedFormats() {
            return ["qr_code"];
          }
          async detect() {
            const corners = [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
              { x: 0, y: 1 },
            ];
            return [{ rawValue: "W-42", format: "qr_code", cornerPoints: corners, boundingBox: new DOMRectReadOnly(0, 0, 1, 1) }];
          }
        },
      });
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => {
            if (camera === "denied") throw new DOMException("The camera refused.", "NotAllowedError");
            const canvas = document.createElement("canvas");
            canvas.width = 640;
            canvas.height = 640;
            const paint = canvas.getContext("2d")!;
            const draw = () => {
              paint.fillStyle = "#fff";
              paint.fillRect(0, 0, 640, 640);
            };
            draw();
            setInterval(draw, 50);
            const stream = canvas.captureStream(20);
            await new Promise((painted) => requestAnimationFrame(() => requestAnimationFrame(painted)));
            return stream;
          },
        },
      });
    }, options.camera);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = pageErrors(page);
  await page.goto(`${server.url.origin}/code/${codeId}${options.path ?? "/"}${options.hold ? "?hold" : ""}`);
  await page.evaluate(() => document.fonts.ready);
  return { page, errors, close: () => context.close() };
}

const boxes = (page: Page) =>
  page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    // Code's own blocks, and the shared panels that draw its data: sections, frames and key-figure tiles.
    blocks: Array.from(
      document.querySelectorAll("[data-code-block], .k2b-dashboard-section, .k2b-dashboard-frame, .k2b-stat-cell, .k2b-chart-explorer"),
    ).map((element) => {
      const rect = element.getBoundingClientRect();
      return [
        element.getAttribute("data-code-block") ?? element.classList[0],
        Math.round(rect.left + window.scrollX),
        Math.round(rect.top + window.scrollY),
        Math.round(rect.width),
        Math.round(rect.height),
      ];
    }),
    text: document.querySelector("main")?.innerText,
  }));

describe("Code page in a browser", () => {
  test("the Newsletter demo from Code data fits at 1280 and 390 px and keeps every panel from server to browser", async () => {
    for (const width of [1280, 390]) {
      const { page, errors, close } = await open(width, { hold: true, path: "/newsletter" });
      try {
        await settled(page);
        const server = await boxes(page);
        expect(server.overflow).toBeLessThanOrEqual(0);
        expect(server.blocks.filter(([kind]) => kind === "k2b-stat-cell")).toHaveLength(4);
        if (shots) await page.screenshot({ path: join(shots, `newsletter-${width}-light.png`), fullPage: true });
        await page.evaluate(() => (window as unknown as { mount: () => void }).mount());
        await settled(page);
        expect(await boxes(page)).toEqual(server);
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }
  }, 60_000);

  for (const width of [1280, 390]) {
    test(`${width}px: every block fits, and the first client render shows the server's page in place`, async () => {
      const { page, errors, close } = await open(width, { hold: true });
      try {
        await settled(page);
        const server = await boxes(page);
        expect(server.overflow).toBeLessThanOrEqual(0);
        expect(server.blocks.map(([kind]) => kind)).toContain("k2b-chart-explorer");
        if (shots) {
          mkdirSync(shots, { recursive: true });
          await page.screenshot({ path: join(shots, `code-page-${width}-light.png`), fullPage: true });
        }
        await page.evaluate(() => (window as unknown as { mount: () => void }).mount());
        await settled(page);
        expect(await boxes(page)).toEqual(server);
        await page.evaluate(() => {
          document.documentElement.className = "dark";
        });
        // The theme change starts colour transitions on every control; they end on their own.
        await page.waitForFunction(() =>
          document
            .getAnimations()
            .every(
              (animation) =>
                animation.timeline !== document.timeline ||
                animation.playState !== "running" ||
                !Number.isFinite(animation.effect?.getComputedTiming().endTime),
            ),
        );
        expect((await boxes(page)).overflow).toBeLessThanOrEqual(0);
        if (shots) await page.screenshot({ path: join(shots, `code-page-${width}-dark.png`), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }, 60_000);

    test(`${width}px: actions and forms send without a reload, keep their place while sending and carry the CSRF field`, async () => {
      const { page, errors, close } = await open(width);
      try {
        await page.evaluate(() => {
          (window as unknown as { sameDocument: boolean }).sameDocument = true;
        });
        await settled(page);
        const before = await boxes(page);
        state.replies.push({
          delay: 700,
          response: () => treeResponse(withChildren(home, [{ kind: "Notice", tone: "success", title: "Marked ready" }, ...home.children])),
        });
        const ready = page.getByRole("button", { name: "Mark ready", exact: true });
        await ready.click();
        await page.waitForSelector('[data-code-block="Button"] button[aria-busy="true"]');
        if (shots && width === 390) await page.screenshot({ path: join(shots, "code-page-sending-light.png") });
        // Sending changes nothing around the button.
        // settled: the busy moment is the subject; its spinner never stops while the request runs.
        expect((await boxes(page)).blocks).toEqual(before.blocks);
        await page.getByText("Marked ready").waitFor();
        expect(state.posts[0]).toEqual({ path: `/code/${codeId}/ready`, fields: { _csrf: csrf, item: "W-1" }, tree: "tree" });
        expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);

        // The Code answers a form with its validation message; the person's input stays.
        await page.getByLabel("Title", { exact: true }).fill("Lamp");
        await page.getByLabel("Count", { exact: true }).fill("3");
        await page.getByLabel("Urgent", { exact: true }).check();
        await page.getByRole("combobox", { name: "Status", exact: true }).click();
        await page.getByRole("option", { name: "In repair", exact: true }).click();
        state.replies.push({
          response: () =>
            treeResponse(
              check({
                ...home,
                children: home.children.map((child) =>
                  child.kind === "Section"
                    ? {
                        ...child,
                        children: child.children.map((inner) =>
                          inner.kind === "Form"
                            ? {
                                ...inner,
                                fields: inner.fields.map((field) =>
                                  field.name === "title" ? { ...field, value: "Lamp", error: "Choose a longer title." } : field,
                                ),
                              }
                            : inner,
                        ),
                      }
                    : child,
                ),
              }),
            ),
        });
        await page.getByRole("button", { name: "Receive", exact: true }).click();
        await page.getByText("Choose a longer title.").waitFor();
        // Focus continues at the first field the Code marked invalid.
        expect(await page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("barcode");
        expect(state.posts[1]?.fields).toMatchObject({
          _csrf: csrf,
          barcode: "W-1",
          title: "Lamp",
          count: "3",
          urgent: "on",
          status: "repair",
        });
        expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Lamp");
        if (shots && width === 390) await page.screenshot({ path: join(shots, "code-page-validation-light.png"), fullPage: true });

        // A redirect opens the next page in place; Back returns to the first.
        state.replies.push({ response: () => new Response(null, { status: 303, headers: { Location: `/code/${codeId}/items/W-1` } }) });
        await page.getByRole("button", { name: "Receive", exact: true }).click();
        await page.waitForURL(`**/code/${codeId}/items/W-1`);
        await page.getByRole("heading", { name: "Chair", level: 1 }).waitFor();
        expect(await page.title()).toBe("Chair · Cloud");
        expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("H1");
        await page.goBack();
        await page.waitForURL(`**/code/${codeId}/`);
        await page.getByRole("heading", { name: "Workshop", level: 1 }).waitFor();
        expect(await page.evaluate(() => (window as unknown as { sameDocument?: boolean }).sameDocument)).toBe(true);

        // Failures say what happened and leave the controls ready to try again.
        state.replies.push({ response: () => failure(403, "code_csrf_required") });
        await page.getByRole("button", { name: "Print label", exact: true }).click();
        await page
          .getByRole("region", { name: "Notifications" })
          .getByText("This page is out of date. Reload it and repeat the step.")
          .waitFor();
        expect(await page.getByRole("button", { name: "Print label", exact: true }).isEnabled()).toBe(true);
        state.replies.push({ response: () => failure(503, "code_request_busy") });
        await page.getByRole("button", { name: "Receive", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "The Code is busy. Try again in a moment." }).waitFor();
        // An answer that breaks off may have run: the form says so, and the next submit still works.
        state.replies.push({
          response: () => new Response("{", { headers: { "X-Code-Page": "tree", "Content-Type": "application/json" } }),
        });
        await page.getByRole("button", { name: "Receive", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "The answer was lost." }).waitFor();
        state.replies.push({ response: () => failure(503, "code_request_busy") });
        await page.getByRole("button", { name: "Receive", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "The Code is busy. Try again in a moment." }).waitFor();
        if (shots && width === 390) await page.screenshot({ path: join(shots, "code-page-failure-light.png"), fullPage: true });
        expect(errors).toEqual([]);
      } finally {
        await close();
      }
    }, 60_000);
  }

  test("followed events load the page again; while someone types, new data waits in a toast", async () => {
    const { page, errors, close } = await open(1280);
    try {
      expect(await page.evaluate(() => (window as unknown as { followed: string[] }).followed)).toEqual(["grids.record.changed"]);
      const table = (rows: { item: string; status: string; count: number }[]) =>
        withChildren(
          home,
          home.children.map((child) =>
            child.kind === "Section"
              ? {
                  ...child,
                  children: child.children.map((inner) => (inner.kind === "Table" && inner.title === "Items" ? { ...inner, rows } : inner)),
                }
              : child,
          ),
        );
      state.trees.set("/", table([{ item: "Desk", status: "Received", count: 1 }]));
      const emit = () => page.evaluate(() => (window as unknown as { emit: () => void }).emit());
      await emit();
      await page.getByRole("cell", { name: "Desk" }).waitFor();
      // A burst of events ends in at most one more load after the running one.
      const loads = state.treeLoads;
      await page.evaluate(() => {
        for (let i = 0; i < 5; i++) (window as unknown as { emit: () => void }).emit();
      });
      await page.waitForFunction(() => !document.querySelector("main[aria-busy]"));
      expect(state.treeLoads - loads).toBeLessThanOrEqual(2);

      // Typing that starts while a load runs keeps its input; the new data waits.
      state.treeDelay = 500;
      state.trees.set("/", table([{ item: "Shelf", status: "Received", count: 1 }]));
      await emit();
      await page.waitForSelector("main[aria-busy]");
      await page.getByLabel("Title", { exact: true }).fill("Typed");
      await page.getByRole("region", { name: "Notifications" }).getByText("This page has new data.").waitFor();
      state.treeDelay = 0;
      expect(await page.getByRole("cell", { name: "Shelf" }).count()).toBe(0);
      expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Typed");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await page.getByRole("cell", { name: "Shelf" }).waitFor();
      // A reload that fails leaves every panel's data in place and says when it was read, with Try again.
      state.trees.delete("/");
      await emit();
      await page.getByText("Refresh failed").first().waitFor();
      expect(await page.getByRole("cell", { name: "Shelf" }).count()).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  test("tables sort on their headers; the scanner writes into its field and sends nothing", async () => {
    const { page, errors, close } = await open(390, { camera: "code" });
    try {
      const items = page
        .locator(".k2b-dashboard-frame")
        .filter({ has: page.locator("table") })
        .first();
      // Like every shared table, the first click sorts descending and the second ascending.
      await items.getByRole("button", { name: "Count" }).click();
      expect(await items.getByRole("row").nth(1).innerText()).toContain("Lamp");
      await items.getByRole("button", { name: "Count" }).click();
      expect(await items.getByRole("row").nth(1).innerText()).toContain("Bicycle");
      await page.getByLabel("Title", { exact: true }).fill("Typed");
      await page.getByRole("button", { name: "Scan", exact: true }).click();
      await page.getByRole("dialog", { name: "Scan code" }).waitFor({ state: "detached" });
      expect(await page.locator('input[name="barcode"]').inputValue()).toBe("W-42");
      // Closing the scanner leaves its history entry at the same address: nothing loads and nothing is sent.
      await page.waitForFunction(() => !document.querySelector("main[aria-busy]"));
      expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Typed");
      expect(state.treeLoads).toBe(0);
      expect(state.posts).toEqual([]);
      // Back closes the scanner, not the page, and keeps what was typed.
      await page.getByRole("button", { name: "Scan", exact: true }).click();
      await page.getByRole("dialog", { name: "Scan code" }).waitFor();
      await page.goBack();
      await page.getByRole("dialog", { name: "Scan code" }).waitFor({ state: "detached" });
      await page.waitForFunction(() => !document.querySelector("main[aria-busy]"));
      expect(page.url()).toBe(`${server.url.origin}/code/${codeId}/`);
      expect(await page.getByLabel("Title", { exact: true }).inputValue()).toBe("Typed");
      expect(state.treeLoads).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
    const denied = await open(390, { camera: "denied" });
    try {
      await denied.page.getByRole("button", { name: "Scan", exact: true }).click();
      await denied.page.getByText("Camera access is off. Allow it in the browser settings, or type the code.").waitFor();
      expect(await denied.page.evaluate(() => document.activeElement?.getAttribute("name"))).toBe("barcode");
      if (shots) await denied.page.screenshot({ path: join(shots, "code-page-camera-denied-light.png") });
      expect(denied.errors).toEqual([]);
    } finally {
      await denied.close();
    }
  }, 60_000);
});
