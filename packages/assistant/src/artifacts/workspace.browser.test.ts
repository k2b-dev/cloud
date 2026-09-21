import { expect, test } from "bun:test";
import { chromium } from "playwright";

// Use the monorepo's existing UI test compiler; this does not change the app build.
const ui = new URL("../../../ui/", import.meta.url).pathname;

test("source tabs preserve drafts and history, guard closing, and fill the workspace", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      if (path === "/ui.css") return new Response(Bun.file(`${ui}dist/styles.css`));
      if (path === "/app.css") return new Response(Bun.file(new URL("../styles/app.css", import.meta.url)));
      if (path.startsWith("/api/assistant/artifacts/"))
        return Response.json({
          id: "00000000-0000-4000-8000-000000000001",
          title: "Example",
          revision: 1,
          permission: "admin",
          source: {
            entry: "main.js",
            files: [
              { path: "main.js", content: "export default () => 42;" },
              { path: "helper.js", content: "export const answer = 42;" },
            ],
          },
        });
      return new Response(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"><link rel="stylesheet" href="/app.css"><body class="k2b-ui" style="margin:0"><div id="root" style="height:100vh"></div><script src="/bundle.js"></script>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    page.on("pageerror", (error) => console.error(error));
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Source", exact: true }).click();
    await page.getByRole("treeitem", { name: /helper.js/ }).waitFor();
    await page.getByRole("treeitem", { name: /main.js/ }).press("Enter");
    const input = page.getByRole("textbox");
    await input.fill("export default () => 99;");
    await page.getByRole("tab", { name: "Example", exact: true }).click();
    await page.getByRole("tab", { name: "main.js", exact: true }).click();
    expect(await input.inputValue()).toBe("export default () => 99;");
    await input.press("ControlOrMeta+z");
    expect(await input.inputValue()).toBe("export default () => 42;");
    await input.press("ControlOrMeta+Shift+z");
    expect(await input.inputValue()).toBe("export default () => 99;");
    await page.waitForFunction(() => document.querySelector(".k2b-autocomplete__preview")?.textContent?.includes("99"));
    expect(await page.locator(".artifact-code .hl-keyword").count()).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Close tab: main.js", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await input.inputValue()).toBe("export default () => 99;");
    await page.setViewportSize({ width: 390, height: 844 });
    expect((await page.locator(".artifact-code").boundingBox())!.height).toBeGreaterThan(500);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(requests.some((path) => path.endsWith("/compiled"))).toBe(false);
    await page.reload();
    await page.getByRole("textbox").waitFor();
    expect(await input.inputValue()).toBe("export default () => 42;");
    expect(requests.some((path) => path.endsWith("/compiled"))).toBe(false);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 30_000);
