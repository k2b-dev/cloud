import { test, expect } from "bun:test";
import { chromium } from "playwright";
import { SecretSave, SecretView } from "./http-contracts";
import { z } from "zod";

test("trusted secret dialogs store directly, clear values, support replacement and never return credentials to chat", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./secrets-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (await build.exited) throw new Error(error);
  let entries: z.infer<typeof SecretView>[] = [];
  let writes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/bundle.js") return new Response(code, { headers: { "content-type": "application/javascript; charset=utf-8" } });
      if (path === "/ui.css") return new Response(Bun.file(new URL("../../../ui/dist/styles.css", import.meta.url)));
      if (path.endsWith("/secrets/list")) return Response.json(entries);
      if (path.endsWith("/secrets") && req.method === "PUT") {
        const input = z.object({ secret: SecretSave }).parse(await req.json());
        expect(input.secret.value).toBe("fixture-value");
        writes++;
        if (writes === 2) expect(input.secret.expectedRevision).toBe(entries[0]!.revision);
        entries = [SecretView.parse({ ...input.secret, revision: crypto.randomUUID(), configured: true })];
        return Response.json(entries[0]);
      }
      if (path.endsWith("/secrets/remove")) {
        entries = [];
        return Response.json({ deleted: true });
      }
      return new Response(
        '<!doctype html><link rel="stylesheet" href="/ui.css"><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await chromium.launch({ headless: true, channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Request secret", exact: true }).click();
    await page.getByLabel("Secret value", { exact: true }).fill("fixture-value");
    expect(await page.getByLabel("Secret value", { exact: true }).getAttribute("type")).toBe("password");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes('"configured":true'));
    expect(await page.locator("output").textContent()).toBe('{"configured":true,"name":"crm"}');
    await page.getByRole("button", { name: "Manage secrets", exact: true }).click();
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    expect(await page.getByLabel("Secret value", { exact: true }).inputValue()).toBe("");
    await page.getByLabel("Secret value", { exact: true }).fill("fixture-value");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="password"]')?.value === "");
    expect(writes).toBe(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/assistant-secrets-mobile.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Request HTTP", exact: true }).click();
    await page.getByRole("button", { name: "Send request", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "true");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60000);
