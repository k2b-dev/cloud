// A Studio app in the chat: reserved height, start on click, live app, sanitized exports,
// stop and unmount, and the open action of a saved app.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { appAssetResponse, appAssetsJson } from "./html/test-assets";

const FILES = [
  {
    path: "index.html",
    content:
      '<main><header class="row"><h1>Inventory</h1></header><div class="grid"><div class="stat"><span>Total</span><strong id="total">20</strong></div></div><label>Quantity <input id="quantity" type="number" value="2"></label></main>',
  },
  {
    path: "app.js",
    content: `const total = document.querySelector("#total");
document.querySelector("#quantity").addEventListener("input", (event) => (total.textContent = String(Number(event.target.value) * 10)));
document.querySelector("main").insertAdjacentHTML("beforeend", cloud.chart({ kind: "bar", title: "Umsatz", data: [{ label: "Jan", value: 1200 }], tooltip: { label: "Umsatz", format: { style: "currency", currency: "EUR" } } }));`,
  },
];
const BROKEN = [
  { path: "index.html", content: "<main><h1>Inventory</h1></main>" },
  { path: "app.js", content: 'throw new Error("Your Cloud session expired. Sign in again at https://login.example");' },
];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let release: () => void = () => {};
let pdfHtml = "";
let assets = "";
const requests: string[] = [];

beforeAll(async () => {
  const build = Bun.spawn(
    ["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./chat-presentation-browser-harness.tsx"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [bundle, buildError] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (await build.exited) throw new Error(buildError);
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../cloud/", import.meta.url).pathname))).default;
  const css = await Bun.build({ entrypoints: [new URL("../styles/app.css", import.meta.url).pathname], plugins: [tailwind] });
  if (!css.success) throw new Error(css.logs.join("\n"));
  const appCss = await css.outputs[0]!.text();
  assets = await appAssetsJson();
  let ready = Promise.withResolvers<void>();
  release = () => {
    ready.resolve();
    ready = Promise.withResolvers<void>();
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      requests.push(path);
      if (path === "/bundle.js") return new Response(bundle, { headers: { "content-type": "application/javascript" } });
      if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
      if (path === "/app.css") return new Response(appCss, { headers: { "content-type": "text/css" } });
      if (path === "/api/assistant/artifacts/runtime/app-assets" || path === "/api/assistant/artifacts/runtime/chart-parts")
        return appAssetResponse(assets, path);
      if (path === "/api/assistant/artifacts/runtime/context")
        return Response.json({ locale: "de-DE", timeZone: "Europe/Berlin", user: null });
      if (path === "/api/assistant/artifacts/runtime/pdf") {
        const form = await req.formData();
        pdfHtml = JSON.parse(String(form.get("request"))).html;
        return new Response("%PDF-1.4\nfixture", { headers: { "Content-Type": "application/pdf" } });
      }
      if (path === "/api/assistant/artifacts/aBc234")
        return Response.json({ id: "aBc234", title: "Inventory", source: { entry: "index.html", files: FILES }, sourceRevision: 3 });
      if (path.startsWith("/api/assistant/artifacts/presentations/")) {
        await ready.promise;
        const app = path.endsWith("2");
        return Response.json({
          id: path.slice(path.lastIndexOf("/") + 1),
          conversationId: "abc234",
          title: "Inventory",
          files: app ? null : path.endsWith("3") ? BROKEN : FILES,
          artifactId: app ? "aBc234" : null,
        });
      }
      return new Response(
        `<!doctype html><html lang="de" class="${url.searchParams.get("theme") ?? "light"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui" style="margin:0;padding:1rem"><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  browser = await launchBrowser();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const app = (page: import("playwright").Page) => page.frameLocator("iframe.studio-app-frame").frameLocator("iframe");

test("a chat app keeps its height, starts on a click, exports a static copy and stops cleanly", async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 800 }, acceptDownloads: true });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    const card = page.locator(".assistant-chat-presentation");
    await card.waitFor();
    const reserved = (await card.boundingBox())!.height;
    expect(reserved).toBe(360);
    // The chat sidebar jumps to a result through this attribute.
    expect(await card.getAttribute("data-presentation-id")).toBe("00000000-0000-4000-8000-000000000001");
    release();
    const start = card.getByRole("button", { name: "Starten", exact: true });
    await start.waitFor();
    expect((await card.boundingBox())!.height).toBe(reserved);
    // Nothing runs before the click: no frame and no runtime assets.
    expect(await page.locator("iframe").count()).toBe(0);
    expect(requests).not.toContain("/api/assistant/artifacts/runtime/app-assets");
    await start.click();
    await app(page).locator("#total").waitFor();
    await page.waitForFunction(() => !document.querySelector(".studio-app[aria-busy]"));
    expect((await card.boundingBox())!.height).toBe(reserved);
    await app(page).locator("#quantity").fill("3");
    await app(page).getByText("30", { exact: true }).waitFor();

    const html = page.waitForEvent("download");
    await card.getByRole("button", { name: "Downloads", exact: true }).click();
    await page.getByRole("menuitem", { name: "HTML", exact: true }).click();
    // saveAs works with a local and a remote (run-server) browser alike.
    const copy = `${tmpdir()}/chat-app-${crypto.randomUUID()}.html`;
    await (await html).saveAs(copy);
    const exported = await Bun.file(copy).text();
    await rm(copy, { force: true });
    expect(exported).toContain(">30<");
    // The copy shows what the person entered, not the initial value.
    expect(exported).toContain('value="3"');
    expect(exported).not.toMatch(/<script/i);
    expect(exported).toContain("default-src 'none'");
    const pdf = page.waitForEvent("download");
    await card.getByRole("button", { name: "Downloads", exact: true }).click();
    await page.getByRole("menuitem", { name: "PDF", exact: true }).click();
    expect((await pdf).suggestedFilename()).toBe("Inventory.pdf");
    expect(pdfHtml).toContain(">30<");
    expect(pdfHtml).not.toMatch(/<script/i);
    const valueTable = /<table class="k2b-chart__table" hidden="">[\s\S]*?<\/table>/g;
    for (const snapshot of [exported, pdfHtml]) {
      const tables = [...snapshot.matchAll(valueTable)];
      expect(tables).toHaveLength(1);
      expect(tables[0]![0]).toContain("<caption>Umsatz</caption>");
      expect(tables[0]![0]).toContain('<td class="num">1.200&nbsp;€</td>');
    }

    await card.getByRole("button", { name: "Stoppen", exact: true }).click();
    await page.locator("iframe").waitFor({ state: "detached" });
    expect((await card.boundingBox())!.height).toBe(reserved);
    await start.click();
    await app(page).locator("#total").waitFor();
    await page.getByRole("button", { name: "Leave chat", exact: true }).click();
    await page.locator("iframe").waitFor({ state: "detached" });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
}, 60000);

test("a saved app in the chat runs its current source and opens beside the chat", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(new URL("?presentation=00000000-0000-4000-8000-000000000002&theme=dark", server.url).href);
    release();
    const card = page.locator(".assistant-chat-presentation");
    await card.getByRole("button", { name: "Starten", exact: true }).click();
    await app(page).locator("#total").waitFor();
    expect(await app(page).locator("html").getAttribute("data-theme")).toBe("dark");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.getByRole("button", { name: "Öffnen", exact: true }).click();
    expect(await page.evaluate(() => globalThis.openedApps)).toEqual(["aBc234:Inventory"]);
  } finally {
    await context.close();
  }
}, 60000);

test("a chat app that fails while starting says so in Cloud's words, not the app's", async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(new URL("?presentation=00000000-0000-4000-8000-000000000003", server.url).href);
    release();
    const card = page.locator(".assistant-chat-presentation");
    await card.getByRole("button", { name: "Starten", exact: true }).click();
    await card.getByRole("alert").filter({ hasText: "Beim Start der App ist ein Fehler aufgetreten" }).waitFor();
    expect(await card.textContent()).not.toContain("session expired");
  } finally {
    await context.close();
  }
}, 60000);

test("an interactive host prepares parts at low priority; a chart-free start reuses them", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    await context.addInitScript(() => {
      const fetch = globalThis.fetch;
      Reflect.set(globalThis, "partPriorities", []);
      globalThis.fetch = Object.assign(
        (input: RequestInfo | URL, options?: RequestInit) => {
          if (String(input).endsWith("/chart-parts")) Reflect.get(globalThis, "partPriorities").push(options?.priority);
          return fetch(input, options);
        },
        { preconnect: fetch.preconnect },
      );
    });
    const page = await context.newPage();
    let partRequests = 0;
    await page.route("**/chart-parts", async (route) => {
      partRequests++;
      if (partRequests > 1) return route.abort();
      await route.fulfill({ json: await appAssetResponse(assets, "/chart-parts").json() });
    });
    // No chart calls: the measured regression also affected ordinary apps.
    await page.route("**/presentations/*", (route) =>
      route.fulfill({
        json: {
          id: "00000000-0000-4000-8000-000000000001",
          title: "Plain app",
          conversationId: "abc234",
          artifactId: null,
          files: [FILES[0]],
        },
      }),
    );
    await page.goto(server.url.href);
    const start = page.getByRole("button", { name: "Starten", exact: true });
    await start.waitFor();
    const prepared = page.waitForResponse((response) => response.url().endsWith("/chart-parts"));
    await page.evaluate(() => globalThis.chartPreparation.prepare());
    await (await prepared).finished();
    expect(await page.locator("iframe").count()).toBe(0);
    const frameResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/app-assets"));
    await start.click();
    const payload = await (await frameResponse).text();
    expect(payload).not.toContain('"chartParts"');
    expect(payload).not.toContain("k2b-area-layer");
    await page.waitForFunction(() => document.querySelector(".studio-app") && !document.querySelector(".studio-app[aria-busy]"));
    expect(await app(page).locator("#total").textContent()).toBe("20");
    expect(partRequests).toBe(1);
    expect(await page.evaluate(() => Reflect.get(globalThis, "partPriorities"))).toEqual(["low"]);
  } finally {
    await context.close();
  }
});

test("an early start joins in-flight preparation before cold offline first use", async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const releaseParts = Promise.withResolvers<void>();
  try {
    const page = await context.newPage();
    let partRequests = 0;
    await page.route("**/chart-parts", async (route) => {
      partRequests++;
      await releaseParts.promise;
      await route.fulfill({ json: await appAssetResponse(assets, "/chart-parts").json() });
    });
    await page.goto(server.url.href);
    await page.locator(".assistant-chat-presentation").waitFor();
    release();
    const start = page.getByRole("button", { name: "Starten", exact: true });
    await start.waitFor();
    const preparing = page.waitForRequest((request) => request.url().endsWith("/chart-parts"));
    await page.evaluate(() => globalThis.chartPreparation.prepare());
    await preparing;
    const frameResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/app-assets"));
    await start.click();
    await (await frameResponse).finished();
    expect(await page.locator("iframe").count()).toBe(0);
    expect(partRequests).toBe(1);
    releaseParts.resolve();
    await page.waitForFunction(() => document.querySelector(".studio-app") && !document.querySelector(".studio-app[aria-busy]"));
    await context.setOffline(true);
    const requests: string[] = [];
    // WebKit reports local blob module imports too. The offline contract forbids network access.
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) requests.push(request.url());
    });
    await app(page)
      .locator("body")
      .evaluate((element) => {
        element.insertAdjacentHTML("beforeend", Reflect.get(globalThis, "cloud").chart({ kind: "gauge", title: "Offline", value: 75 }));
      });
    await app(page).locator('[data-chart-kind="gauge"] svg').waitFor();
    expect(requests).toEqual([]);
  } finally {
    releaseParts.resolve();
    await context.close();
  }
});

test("preparation cancellation, failure retry and a deployment preserve complete offline assets", async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    let partRequests = 0;
    await page.route("**/chart-parts", async (route) => {
      partRequests++;
      if (partRequests === 1) return route.fulfill({ status: 503 });
      await route.fulfill({ json: await appAssetResponse(assets, "/chart-parts").json() });
    });
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Leave chat" }).waitFor();
    await page.evaluate(() => {
      globalThis.chartPreparation.prepare();
      globalThis.chartPreparation.cancel();
    });
    // Reach idle after both paint boundaries, so an uncancelled preparation has run.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              if (typeof requestIdleCallback === "function") requestIdleCallback(() => resolve());
              else setTimeout(resolve, 0);
            }),
          ),
        ),
    );
    expect(partRequests).toBe(0);
    expect(
      await page.evaluate(() =>
        globalThis.chartPreparation.load().then(
          () => false,
          () => true,
        ),
      ),
    ).toBe(true);
    let fullRequests = 0;
    await page.route("**/app-assets*", async (route) => {
      if (!new URL(route.request().url()).search) {
        fullRequests++;
        return route.fulfill({ body: assets, contentType: "application/json" });
      }
      const frame: unknown = await appAssetResponse(assets, "/app-assets").json();
      if (typeof frame !== "object" || frame === null || !("chartHashes" in frame)) throw new Error("Expected frame hashes");
      await route.fulfill({ json: { ...frame, chartHashes: { shared: "new-deployment", kinds: {} } } });
    });
    const loaded = await page.evaluate(async () => {
      const assets = await globalThis.chartPreparation.load();
      return { kinds: Object.keys(assets.chartParts.kinds), hash: assets.chartParts.shared.hash };
    });
    expect(partRequests).toBe(2);
    expect(fullRequests).toBe(1);
    expect(loaded.kinds).toContain("gauge");
    expect(loaded.hash).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    release();
    await context.close();
  }
});
