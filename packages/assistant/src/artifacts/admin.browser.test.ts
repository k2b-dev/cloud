import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("Studio administration renders inventory and tests settings without saving secrets", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./admin-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const writes: unknown[] = [],
    tests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/bundle.js") return new Response(code, { headers: { "Content-Type": "text/javascript" } });
      if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
      if (path.endsWith("/database/settings")) {
        if (request.method === "PUT") {
          writes.push(await request.json());
          return Response.json({ url: "http://database.test", tokenSet: true });
        }
        return Response.json({ url: "http://database.test", tokenSet: true });
      }
      if (path.endsWith("/database/test")) {
        tests.push(await request.json());
        return Response.json({ connected: true });
      }
      if (path.endsWith("/access")) return Response.json([]);
      return new Response(
        '<!doctype html><link rel="stylesheet" href="/ui.css"><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.goto(server.url.href);
    await page.getByRole("cell", { name: "Analysis script", exact: true }).waitFor();
    expect(await page.getByRole("cell", { name: "2", exact: true }).count()).toBe(1);
    expect(await page.getByRole("cell", { name: "3", exact: true }).count()).toBe(1);
    await page.getByRole("cell", { name: "Published", exact: true }).waitFor();
    await page.getByRole("cell", { name: "100", exact: true }).waitFor();
    await page.getByRole("button", { name: "1", exact: true }).click();
    await page.getByRole("dialog").getByText("00000000-0000-4000-8000-000000000002", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Database settings", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    expect((await dialog.boundingBox())!.width).toBeLessThan(900);
    expect(await dialog.getByLabel("API token", { exact: true }).inputValue()).toBe("");
    await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
    await dialog.getByText("Connection successful", { exact: true }).waitFor();
    expect(tests).toEqual([{ url: "http://database.test" }]);
    expect(writes).toEqual([]);
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(writes).toEqual([{ url: "http://database.test" }]);
    await page.getByRole("button", { name: "Manage access", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60000);
