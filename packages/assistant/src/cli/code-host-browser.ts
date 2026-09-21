import type { AiFrontendToolHandler } from "@k2b/cloud/ai/solid";
import { type Browser, chromium } from "playwright";
import type { CapabilityDecision, CodeApproval } from "../artifacts/runtime/capabilities";
import type {} from "../artifacts/runtime/cli-host";
import { appEnv } from "../env";
import { HOST_HEADER } from "./code-host-http";

type Call = Parameters<AiFrontendToolHandler>[0];
export async function createBrowserCodeHost(
  endpoint: { origin: string; token: string },
  approve?: (request: CodeApproval) => Promise<CapabilityDecision>,
  unattended = false,
) {
  const browser: Browser = await chromium
    .launch({
      headless: true,
      chromiumSandbox: true,
      ...(appEnv.CLOUD_CLI_CHROMIUM ? { executablePath: appEnv.CLOUD_CLI_CHROMIUM } : {}),
    })
    .catch((cause) => {
      throw new Error(
        "Code mode could not start sandboxed Chromium. Install Chromium or set CLOUD_CLI_CHROMIUM. On Linux, enable unprivileged user namespaces and the documented container seccomp profile.",
        { cause },
      );
    });
  const lifetime = new AbortController();
  browser.on("disconnected", () => lifetime.abort());
  try {
    const page = await browser.newPage();
    const startupErrors: string[] = [];
    page.on("pageerror", (error) => startupErrors.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (request.frame() !== page.mainFrame() || url.origin !== endpoint.origin) return route.abort();
      if (
        url.pathname !== "/" &&
        !url.pathname.startsWith("/api/assistant/artifacts/") &&
        !url.pathname.startsWith("/api/ai/conversations/")
      )
        return route.abort();
      // Native HTTP carries binary bodies with backpressure. Only this trusted
      // main frame receives the ephemeral loopback credential; never the sandbox.
      return route.continue({ headers: { ...request.headers(), [HOST_HEADER]: endpoint.token } });
    });
    await page.exposeFunction("assistantCodeApprove", (request: CodeApproval) => {
      if (!approve)
        throw new Error(
          "Capability requires approval. Use an interactive Assistant CLI chat or explicitly allow this capability with --approve.",
        );
      return approve(request);
    });
    await page.goto(endpoint.origin);
    const response = await fetch(new URL("/api/assistant/artifacts/runtime/host.js", endpoint.origin), {
      headers: { [HOST_HEADER]: endpoint.token },
      signal: lifetime.signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Code host unavailable: HTTP ${response.status}`);
    await page.evaluate((value) => {
      window.assistantCodeUnattended = value;
    }, unattended);
    await page.addScriptTag({ content: await response.text() });
    if (startupErrors.length) throw new Error(`Code host failed to initialize: ${startupErrors.join("; ")}`);
    return {
      health: () => page.evaluate(() => undefined),
      execute: (call: Call) => page.evaluate((call) => window.assistantCodeExecute(call), call),
      call: (call: Call) => page.evaluate((call) => window.assistantCodeCall(call), call),
      close: () => {
        lifetime.abort();
        return browser.close();
      },
    };
  } catch (error) {
    lifetime.abort();
    await browser.close();
    throw error;
  }
}
