import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("compact context hides runs; Studio reuses cards, menus and explicit panel starts", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./context-browser-harness.tsx"], { stdout: "pipe", stderr: "pipe" });
  const [code, error] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (await build.exited) throw new Error(error);
  const requests: string[] = [];
  const app = { id: "AAAAA2", title: "Sales dashboard", description: "Sales by region", kind: "app", icon: "ti ti-chart-bar", permission: "admin", revision: 1, publishedRevision: null, publishedVersion: null, updatedAt: new Date().toISOString(), forkedFromId: null, forkedFromRevision: null };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(path);
    if (path === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript" } });
    if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
    if (path === "/app.css") return new Response(Bun.file(new URL("../styles/app.css", import.meta.url)));
    if (path.endsWith("/context")) return Response.json({ chatId: "chat-one", viewerUserId: "test", apps: [app], files: [], tasks: [], sources: [{ kind: "resource", key: app.id, title: app.title, preview: "App · R1 · Draft", ref: { type: "assistant.artifact", id: app.id }, icon: app.icon }], runCount: 3, runs: [{ id: "run-1", status: "ready", createdAt: new Date().toISOString() }] });
    if (path.endsWith("/AAAAA2")) return Response.json({ ...app, sourceRevision: 1, source: { entry: "main.ts", files: [{ path: "main.ts", content: "export default () => 1" }] } });
    if (path.endsWith("/compiled")) return Response.json({ message: "Fixture stops at execution boundary" }, { status: 500 });
    return new Response('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui" style="margin:0"><div id="root"></div><script src="/bundle.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.setDefaultTimeout(3000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(server.url.href);
    const context = page.locator('[data-assistant-context="compact"]');
    expect(await context.getByRole("button", { name: /View all.*4/ }).count()).toBe(1);
    await context.getByRole("button", { name: app.title, exact: false }).click();
    await page.getByRole("tab", { name: app.title, exact: true }).waitFor();
    expect(requests.some(path => path.endsWith("/compiled"))).toBe(false);
    await page.locator(".artifact-workspace__tabs").getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("menuitem", { name: "Studio", exact: true }).click();
    expect(await context.getByText("Recent one-off runs").count()).toBe(0);
    await page.locator(".assistant-studio-card").waitFor();
    expect(await page.locator(".assistant-studio-card").count()).toBe(1);
    expect(await page.locator(".artifact-workspace").getByRole("heading", { name: "Studio", exact: true }).count()).toBe(0);
    expect(await page.getByRole("table").getByText("Succeeded").count()).toBe(1);
    expect(requests.some(path => path.endsWith("/compiled"))).toBe(false);
    const card = page.locator(".assistant-studio-card");
    await card.getByRole("button", { name: /Actions/ }).click();
    await page.getByRole("menuitem", { name: "Manage access", exact: true }).waitFor();
    await page.keyboard.press("Escape");
    expect(await card.getByRole("link", { name: "Open in new tab" }).getAttribute("target")).toBe("_blank");
    const compiling = page.waitForRequest(request => new URL(request.url()).pathname.endsWith("/compiled"));
    await card.getByRole("button", { name: "Start", exact: true }).click();
    await compiling;
    expect(await page.getByRole("tab", { name: app.title, exact: true }).count()).toBe(1);
    await page.getByRole("tab", { name: "Studio", exact: true }).click();
    await page.locator(".assistant-studio-card").getByRole("button", { name: "Start", exact: true }).click();
    expect(await page.getByRole("tab", { name: app.title, exact: true }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.getByRole("tab", { name: "Studio", exact: true }).click();
    await page.screenshot({ path: "/tmp/assistant-studio-slice.png" });
  } finally { await browser.close(); await server.stop(true); }
}, 20000);
