import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("sidebar dropdown icons are centered without changing regular triggers", async () => {
  const build = Bun.spawn(
    [
      "bun",
      new URL("./workspace-browser-build.ts", import.meta.url).pathname,
      new URL("./sidebar-dropdown-browser-harness.tsx", import.meta.url).pathname,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (new URL(request.url).pathname === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript" } });
      if (new URL(request.url).pathname === "/ui.css")
        return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
      return new Response(
        '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/ui.css"><div id="root"></div><script src="/bundle.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    const centers = await page.locator("aside button i").evaluateAll((icons) =>
      icons.map((icon) => {
        const rect = icon.getBoundingClientRect();
        return rect.x + rect.width / 2;
      }),
    );
    expect(centers.length).toBe(2);
    expect(Math.abs(centers[0]! - centers[1]!)).toBeLessThan(1);
    await page.getByRole("button", { name: "Chats", exact: true }).click();
    await page.getByRole("menuitem", { name: "All chats" }).click();
    await page.getByRole("button", { name: "Normal", exact: true }).click();
    await page.getByRole("menuitem", { name: "Normal item" }).click();
    expect(await page.getByRole("button", { name: "Normal", exact: true }).evaluate((button) => getComputedStyle(button).display)).toBe(
      "flex",
    );
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 30000);
