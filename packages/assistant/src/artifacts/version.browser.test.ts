import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { appRuntimeRoute, htmlApp } from "./html/test-assets";

test("a running app keeps its state while saved versions arrive, and a newer revision needs an explicit restart", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./version-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  let revision = 1;
  let unavailable = false;
  const publishRequests: number[] = [];
  const source = (current: number) =>
    htmlApp(
      `<p id="status" role="status">Ready ${current}</p><label>Amount <input id="amount"></label>`,
      `const status = document.querySelector("#status");
document.querySelector("#amount").addEventListener("input", (event) => {
  status.textContent = event.target.value === "abc" ? "Enter a valid amount" : "Valid";
});`,
    );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript" } });
      const runtime = await appRuntimeRoute(url.pathname);
      if (runtime) return runtime;
      if (unavailable && url.pathname.startsWith("/api/")) return new Response("Unavailable", { status: 502 });
      if (url.pathname.endsWith("/versions")) return Response.json({ items: [], page: 1, hasNext: false });
      if (url.pathname.endsWith("/publish")) {
        publishRequests.push((await request.json()).expectedRevision);
        return Response.json({ message: "Restart before publishing." }, { status: 409 });
      }
      if (url.pathname.startsWith("/api/"))
        return Response.json({
          id: "test",
          title: "Test",
          revision,
          sourceRevision: revision,
          permission: "admin",
          publishedRevision: null,
          source: source(revision),
        });
      return new Response(
        '<!doctype html><meta charset="utf-8"><body class="k2b-ui"><div id="root" style="display:flex;flex-direction:column;height:90vh"></div><script src="/bundle.js"></script>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const app = page.frameLocator("iframe.studio-app-frame").frameLocator("iframe");
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const input = app.getByRole("textbox", { name: "Amount" });
    await app.getByText("Ready 1", { exact: true }).waitFor();
    await input.fill("abc");
    await app.getByText("Enter a valid amount", { exact: true }).waitFor();
    await input.fill("80");
    await app.getByText("Valid", { exact: true }).waitFor();
    unavailable = true;
    await Promise.all([
      page.waitForResponse((response) => response.status() === 502),
      page.getByRole("button", { name: "Tool completed" }).click(),
    ]);
    expect(await input.inputValue()).toBe("80");
    unavailable = false;
    revision = 2;
    await page.getByRole("button", { name: "Tool completed" }).click();
    await page.getByText("A newer revision is available. Restart to use it.").waitFor();
    expect(await input.inputValue()).toBe("80");
    await page.getByRole("button", { name: "Draft", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByText("Restart before publishing.", { exact: true }).waitFor();
    expect(publishRequests).toEqual([1]);
    expect(await input.inputValue()).toBe("80");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Restart", exact: true }).first().click();
    await app.getByText("Ready 2", { exact: true }).waitFor();
    expect(await input.inputValue()).toBe("");
    expect(await page.getByText("A newer revision is available. Restart to use it.").count()).toBe(0);
    revision = 3;
    await input.fill("42");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByText("A newer revision is available. Restart to use it.").waitFor();
    expect(await input.inputValue()).toBe("42");
  } finally {
    await browser.close();
    server.stop(true);
  }
}, 60000);
