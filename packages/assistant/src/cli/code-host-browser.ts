import type { CodeApproval, CapabilityDecision } from "../artifacts/runtime/capabilities";
import type { CloudCliContext } from "@k2b/cloud/cli";
import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import { chromium, type Browser } from "playwright";
import type {} from "../artifacts/runtime/cli-host";

type Call = Parameters<AiFrontendToolHandler>[0];
export async function createBrowserCodeHost(ctx: Pick<CloudCliContext, "fetch">,approve?:(request:CodeApproval)=>Promise<CapabilityDecision>) {
  const browser: Browser = await chromium.launch({
    headless: true,
    ...(process.env.CLOUD_CLI_CHROMIUM ? { executablePath: process.env.CLOUD_CLI_CHROMIUM } : {}),
  }).catch(() => { throw new Error("Code mode needs Chromium. Install it with playwright install chromium, or set CLOUD_CLI_CHROMIUM to an installed Chromium executable."); });
  const lifetime = new AbortController();
  browser.on("disconnected", () => lifetime.abort());
  try {
    const page = await browser.newPage();
    const startupErrors: string[] = [];
    page.on("pageerror", error => startupErrors.push(error.message));
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (request.frame() !== page.mainFrame() || url.origin !== "http://localhost") return route.abort();
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" });
      if (!url.pathname.startsWith("/api/assistant/artifacts/") && !url.pathname.startsWith("/api/ai/conversations/")) return route.abort();
      try {
        const response = await ctx.fetch(url.pathname + url.search, {
          method: request.method(),
          signal: lifetime.signal,
          headers: { "Content-Type": request.headers()["content-type"] ?? "application/json" },
          ...(request.postDataBuffer() ? { body: new Uint8Array(request.postDataBuffer()!).buffer } : {}),
        });
        await route.fulfill({ status: response.status, contentType: response.headers.get("content-type") ?? "application/json", body: Buffer.from(await response.arrayBuffer()) });
      } catch { await route.abort(); }
    });
    await page.exposeFunction("assistantCodeApprove",(request:CodeApproval)=>{
      if(!approve)throw new Error("Capability requires approval. Use an interactive Assistant CLI chat or explicitly allow this capability with --approve.");
      return approve(request);
    });
    await page.goto("http://localhost/");
    const response = await ctx.fetch("/api/assistant/artifacts/runtime/host.js", {signal:lifetime.signal});
    if (!response.ok) throw new Error(`Code host unavailable: HTTP ${response.status}`);
    await page.addScriptTag({ content: await response.text() });
    if (startupErrors.length) throw new Error(`Code host failed to initialize: ${startupErrors.join("; ")}`);
    return {
      health: () => page.evaluate(() => undefined),
      execute: (call: Call) => page.evaluate(call => window.assistantCodeExecute(call), call),
      call: (call: Call) => page.evaluate(call => window.assistantCodeCall(call), call),
      close: () => {lifetime.abort();return browser.close();},
    };
  } catch (error) { lifetime.abort();await browser.close();throw error; }
}
