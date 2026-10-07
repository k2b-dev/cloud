// The standalone runner with real HTML app frames: who starts automatically, access changes,
// stable controls during a restart, hash mirroring and safe mode.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Browser, Page } from "playwright";
import { launchBrowser } from "../../../ui/test/browser";
import { appAssetsJson } from "./html/test-assets";

let browser: Browser;
let code: string;
let appCss: string;
let assets: string;
beforeAll(async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./runner-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  if (exitCode) throw new Error(stderr);
  code = stdout;
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../cloud/", import.meta.url).pathname))).default;
  const css = await Bun.build({ entrypoints: [new URL("../styles/app.css", import.meta.url).pathname], plugins: [tailwind] });
  if (!css.success) throw new Error(css.logs.join("\n"));
  appCss = await css.outputs[0]!.text();
  assets = await appAssetsJson();
  browser = await launchBrowser({ timeout: 10000 });
}, 120_000);
afterAll(async () => {
  await browser?.close();
});

const COUNTER = {
  "index.html": '<main><h1>Counter</h1><p id="count"></p><button id="ping" type="button">Ping</button></main>',
  "app.js": `const out = document.querySelector("#count");
try {
  const count = ((await cloud.kv.user.get("count")) ?? 0) + 1;
  await cloud.kv.user.set("count", count);
  out.textContent = "Counter: " + count;
} catch (error) {
  out.textContent = "Personal storage: " + error.code;
}
document.querySelector("#ping").addEventListener("click", () => (location.hash = "#pinged"));`,
};
type Server = { url: URL; requests: string[]; stop: () => void; state: { serverAccess: boolean; revoked: boolean; canManage: boolean } };
function serve(files: Record<string, string>, state = { serverAccess: true, revoked: false, canManage: true }): Server {
  const personal = new Map<string, unknown>();
  const requests: string[] = [];
  const metadata = () => ({
    id: "Run001",
    title: "Counter",
    sourceRevision: 1,
    publishedVersion: 1,
    serverAccess: state.serverAccess,
    canManage: state.canManage,
    hasInterface: true,
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      requests.push(path);
      if (path === "/bundle.js") return new Response(code, { headers: { "content-type": "application/javascript" } });
      if (path === "/app.css") return new Response(appCss, { headers: { "content-type": "text/css" } });
      if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
      if (path === "/api/assistant/runner/app-assets") return new Response(assets, { headers: { "content-type": "application/json" } });
      if (path === "/api/assistant/artifacts/Run001/storage") {
        if (!state.serverAccess) return Response.json({ message: "No access" }, { status: 403 });
        const input = await request.json();
        if (input.scope !== "user") return Response.json({ message: "Wrong scope" }, { status: 400 });
        if (input.operation === "write") {
          personal.set(input.key, JSON.parse(input.content));
          return Response.json({ written: true });
        }
        return Response.json({ item: personal.has(input.key) ? { content: JSON.stringify(personal.get(input.key)) } : null });
      }
      if (path.startsWith("/api/assistant/runner/Run001")) {
        if (state.revoked) return Response.json({ message: "Unavailable" }, { status: 404 });
        if (path.endsWith("/app"))
          return Response.json({
            metadata: metadata(),
            files: Object.entries(files).map(([path, content]) => ({ path, content })),
            context: { locale: "en-US", timeZone: "UTC", user: state.serverAccess ? { id: "u1", name: "Runner User" } : null },
          });
        return Response.json(metadata());
      }
      if (path.startsWith("/api/")) return new Response("Unexpected protected request", { status: 403 });
      return new Response(
        '<html class="light"><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/ui.css"><style>body{margin:0;overflow:hidden}#root{display:flex;height:100dvh;min-height:0}</style><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return { url: server.url, requests, stop: () => server.stop(true), state };
}
const app = (page: Page) => page.frameLocator("iframe.studio-app-frame").frameLocator("iframe");
const query = (state: Server["state"], extra = "") =>
  `?${state.serverAccess ? "authorized=1&" : ""}${state.canManage ? "manager=1&" : ""}${extra}`;

test("the runner starts an app its viewer manages, mirrors its hash and keeps controls still during a restart", async () => {
  const server = serve(COUNTER);
  const context = await browser.newContext();
  context.setDefaultTimeout(10000);
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.goto(new URL(query(server.state), server.url).href);
    await app(page).getByText("Counter: 1", { exact: true }).waitFor();
    await app(page).getByRole("button", { name: "Ping" }).click();
    await page.waitForFunction(() => location.hash === "#pinged");
    const manage = page.getByRole("button", { name: "Manage", exact: true });
    const preview = page.locator(".artifact-panel__preview");
    const [manageBefore, previewBefore] = [await manage.boundingBox(), await preview.boundingBox()];
    await page.route("**/api/assistant/runner/Run001/app", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.continue();
    });
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('button[aria-busy="true"]'));
    expect(await manage.boundingBox()).toEqual(manageBefore);
    expect(await preview.boundingBox()).toEqual(previewBefore);
    await app(page).getByText("Counter: 2", { exact: true }).waitFor();
    expect(await manage.boundingBox()).toEqual(manageBefore);
    expect(await preview.boundingBox()).toEqual(previewBefore);
  } finally {
    await context.close();
    server.stop();
  }
}, 60000);

test("an app someone else manages waits for Start, and a start that never got ready is not repeated", async () => {
  const server = serve(COUNTER, { serverAccess: true, revoked: false, canManage: false });
  const context = await browser.newContext();
  context.setDefaultTimeout(10000);
  try {
    const page = await context.newPage();
    await page.goto(new URL(query(server.state), server.url).href);
    const start = page.locator(".artifact-panel__preview").getByRole("button", { name: "Start", exact: true });
    await start.waitFor();
    expect(server.requests).not.toContain("/api/assistant/runner/Run001/app");
    await start.click();
    await app(page).getByText("Counter: 1", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector(".studio-app") && !document.querySelector(".studio-app[aria-busy]"));

    // A manager's autostart is skipped once when the previous start of this revision never became ready.
    server.state.canManage = true;
    await page.evaluate(() => sessionStorage.setItem("assistant-app-starting:Run001:1", "1"));
    await page.goto(new URL(query(server.state), server.url).href);
    await page.getByText("did not respond the last time it started", { exact: false }).waitFor();
    await page.locator(".artifact-panel__preview").getByRole("button", { name: "Start", exact: true }).click();
    await app(page).getByText("Counter: 2", { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector(".studio-app") && !document.querySelector(".studio-app[aria-busy]"));
    expect(await page.evaluate(() => sessionStorage.getItem("assistant-app-starting:Run001:1"))).toBeNull();
  } finally {
    await context.close();
    server.stop();
  }
}, 60000);

test("a reload while a manager's app still starts keeps it from starting again", async () => {
  const server = serve({ "index.html": "<main><h1>Hangs</h1></main>", "app.js": "await new Promise(() => {});" });
  const context = await browser.newContext();
  context.setDefaultTimeout(10000);
  try {
    const page = await context.newPage();
    await page.goto(new URL(query(server.state), server.url).href);
    await page.locator("iframe.studio-app-frame").waitFor({ state: "attached" });
    // Leaving the page is no evidence that the start finished: the next load offers Start instead.
    await page.reload();
    await page.getByText("did not respond the last time it started", { exact: false }).waitFor();
    expect(await page.locator("iframe.studio-app-frame").count()).toBe(0);
  } finally {
    await context.close();
    server.stop();
  }
}, 60000);

test("the runner explains access changes, stops after revocation and denies personal storage without access", async () => {
  const server = serve(COUNTER);
  const context = await browser.newContext();
  context.setDefaultTimeout(10000);
  try {
    const page = await context.newPage();
    await page.goto(new URL(query(server.state), server.url).href);
    await app(page).getByText("Counter: 1", { exact: true }).waitFor();
    server.state.serverAccess = false;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("alert").filter({ hasText: "App access changed" }).waitFor();
    expect(await page.locator("iframe.studio-app-frame").count()).toBe(0);
    await page.getByRole("button", { name: "Restart", exact: true }).click();
    await app(page).getByText("Personal storage: denied", { exact: true }).waitFor();
    expect(server.requests.filter((path) => path === "/api/assistant/artifacts/Run001/storage")).toHaveLength(2);
    server.state.revoked = true;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("alert").filter({ hasText: "no longer available" }).waitFor();
    expect(await page.locator("iframe.studio-app-frame").count()).toBe(0);
  } finally {
    await context.close();
    server.stop();
  }
}, 60000);
