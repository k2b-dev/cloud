// A Studio app in the chat: reserved height, start on click, live app, sanitized exports,
// stop and unmount, and the open action of a saved app.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { appAssetsJson } from "./html/test-assets";

const FILES = [
  {
    path: "index.html",
    content:
      '<main><header class="row"><h1>Inventory</h1></header><div class="grid"><div class="stat"><span>Total</span><strong id="total">20</strong></div></div><label>Quantity <input id="quantity" type="number" value="2"></label></main>',
  },
  {
    path: "app.js",
    content: `const total = document.querySelector("#total");
document.querySelector("#quantity").addEventListener("input", (event) => (total.textContent = String(Number(event.target.value) * 10)));`,
  },
];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let release: () => void = () => {};
let pdfHtml = "";
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
  const assets = await appAssetsJson();
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
      if (path === "/api/assistant/artifacts/runtime/app-assets")
        return new Response(assets, { headers: { "content-type": "application/json" } });
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
          files: app ? null : FILES,
          artifactId: app ? "aBc234" : null,
        });
      }
      return new Response(
        `<!doctype html><html lang="de" class="${url.searchParams.get("theme") ?? "light"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui" style="margin:0;padding:1rem"><div id="root"></div><script src="/bundle.js"></script></body></html>`,
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
    const exported = await Bun.file((await (await html).path())!).text();
    expect(exported).toContain(">30<");
    expect(exported).not.toMatch(/<script/i);
    expect(exported).toContain("default-src 'none'");
    const pdf = page.waitForEvent("download");
    await card.getByRole("button", { name: "Downloads", exact: true }).click();
    await page.getByRole("menuitem", { name: "PDF", exact: true }).click();
    expect((await pdf).suggestedFilename()).toBe("Inventory.pdf");
    expect(pdfHtml).toContain(">30<");
    expect(pdfHtml).not.toMatch(/<script/i);

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
