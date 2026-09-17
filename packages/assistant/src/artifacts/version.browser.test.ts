import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { compileArtifact } from "./runtime/compile";

test("validation text renders and saved versions require explicit restart", async () => {
  const compiled = await compileArtifact({ entry: "main.js", files: [{ path: "main.js", content: `export default () => {
    const status = ui.text({value:"Ready"});
    ui.input({label:"Amount",value:"", onChange: value => {
      if (value === "abc") status.setValue("Enter a valid amount");
      else { status.setValue("Valid"); }
    }});
  };` }] });
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./version-browser-harness.tsx"], { stdout: "pipe", stderr: "pipe" });
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  let revision = 1;
  let unavailable = false;
  const compiledRequests: number[] = [];
  const publishRequests: number[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript" } });
    if (url.pathname.endsWith("/compiled")) {
      compiledRequests.push(Number(url.searchParams.get("revision")));
      return Response.json({ ...compiled, revision });
    }
    if (unavailable && url.pathname.startsWith("/api/")) return new Response("Unavailable", {status: 502});
    if (url.pathname.endsWith("/versions")) return Response.json({ items: [], page: 1, hasNext: false });
    if (url.pathname.endsWith("/publish")) {
      publishRequests.push((await request.json()).expectedRevision);
      return Response.json({ message: "Restart before publishing." }, { status: 409 });
    }
    if (url.pathname.startsWith("/api/")) return Response.json({ id: "test", title: "Test", revision, sourceRevision: revision, permission: "admin", publishedRevision: null });
    return new Response('<!doctype html><meta charset="utf-8"><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script>', { headers: { "content-type": "text/html" } });
  } });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const input = page.getByRole("textbox");
    await input.fill("abc");
    await page.getByText("Enter a valid amount", { exact: true }).waitFor();
    await input.fill("80");
    await page.getByText("Valid", { exact: true }).waitFor();
    expect(await page.getByText("Enter a valid amount", { exact: true }).count()).toBe(0);
    unavailable = true;
    await Promise.all([page.waitForResponse(response => response.status() === 502), page.getByRole("button", { name: "Tool completed" }).click()]);
    expect(await input.inputValue()).toBe("80");
    unavailable = false;
    revision = 2;
    await page.getByRole("button", { name: "Tool completed" }).click();
    await page.getByText("A newer revision is available. Restart to use it.").waitFor();
    expect(await input.inputValue()).toBe("80");
    expect(compiledRequests).toEqual([1]);
    await page.getByRole("button", { name: "Draft", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByText("Restart before publishing.", { exact: true }).waitFor();
    expect(publishRequests).toEqual([1]);
    expect(await input.inputValue()).toBe("80");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Restart", exact: true }).first().click();
    await page.getByText("Ready", { exact: true }).waitFor();
    expect(await input.inputValue()).toBe("");
    expect(compiledRequests).toEqual([1, 2]);
    expect(await page.getByText("A newer revision is available. Restart to use it.").count()).toBe(0);
    revision = 3;
    await input.fill("42");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByText("A newer revision is available. Restart to use it.").waitFor();
    expect(await input.inputValue()).toBe("42");
    expect(compiledRequests).toEqual([1, 2]);
  } finally { await browser.close(); server.stop(true); }
}, 60000);
