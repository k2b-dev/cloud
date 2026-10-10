import { expect, test } from "bun:test";
import { z } from "zod";
import { launchBrowser } from "../../../ui/test/browser";
import { SecretSave, SecretView } from "./http-contracts";

test("trusted secret dialogs store directly, clear values, support replacement and never return credentials to chat", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./secrets-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, error] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (await build.exited) throw new Error(error);
  let entries: z.infer<typeof SecretView>[] = [];
  let writes = 0;
  // The server's view of the Studio app "Ab3dEf": may it remember the website, and does an approval exist.
  let approval: { id: string; origin: string } | null = null;
  const remembered: boolean[] = [];
  const revoked: string[] = [];
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
      if (path.endsWith("/website") && req.method === "POST") {
        const { remember } = z.object({ remember: z.boolean() }).parse(await req.json());
        remembered.push(remember);
        if (remember) approval = { id: crypto.randomUUID(), origin: "https://query1.finance.yahoo.com" };
        return Response.json({ offer: true, allowed: approval !== null, approvalId: approval?.id ?? null });
      }
      if (path === "/api/ai/approval-preferences" && req.method === "GET")
        return Response.json({
          approvals: approval
            ? [
                {
                  id: approval.id,
                  toolName: "website:read",
                  approvalScope: `${approval.origin} resource:Ab3dEf`,
                  conversationId: null,
                  createdAt: new Date().toISOString(),
                  lastUsedAt: null,
                  expiresAt: null,
                  title: "query1.finance.yahoo.com",
                  app: null,
                  website: { origin: approval.origin, resourceId: "Ab3dEf" },
                },
              ]
            : [],
        });
      if (path.startsWith("/api/ai/approval-preferences/") && req.method === "DELETE") {
        revoked.push(path.split("/").at(-1)!);
        approval = null;
        return Response.json({ deleted: true });
      }
      return new Response(
        '<!doctype html><link rel="stylesheet" href="/ui.css"><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
  const browser = await launchBrowser({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } }),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "Request secret", exact: true }).click();
    await page.getByLabel("Allowed HTTPS origin", { exact: true }).fill("not-a-url");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText(/Enter a complete HTTPS address/).waitFor();
    expect(writes).toBe(0);
    await page.getByLabel("Allowed HTTPS origin", { exact: true }).fill("https://api.example.com");
    await page.getByLabel("Secret value", { exact: true }).fill("fixture-value");
    expect(await page.getByLabel("Secret value", { exact: true }).getAttribute("type")).toBe("password");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes('"configured":true'));
    expect(await page.locator("output").textContent()).toBe('{"configured":true,"name":"crm"}');
    await page.getByRole("button", { name: "Manage secrets", exact: true }).click();
    await page.getByRole("button", { name: "Actions · crm", exact: true }).click();
    await page.getByRole("menuitem", { name: "Replace", exact: true }).click();
    expect(await page.getByLabel("Secret value", { exact: true }).inputValue()).toBe("");
    await page.getByLabel("Secret value", { exact: true }).fill("fixture-value");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByLabel("Secret value", { exact: true }).waitFor({ state: "detached" });
    expect(writes).toBe(2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "/tmp/assistant-secrets-mobile.png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Request HTTP", exact: true }).click();
    await page.getByRole("button", { name: "Send request", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "true");

    // A read from a managed app offers the website for the app; afterwards it runs with a receipt that revokes it.
    await page.setViewportSize({ width: 1100, height: 850 });
    await page.getByRole("button", { name: "Fetch quotes", exact: true }).click();
    await page.getByText("https://query1.finance.yahoo.com/v7/finance/quote?symbols=NVDA,AAPL").waitFor();
    await page.getByRole("button", { name: "More options for this request", exact: true }).click();
    await page.getByRole("menuitem", { name: "Allow this website for this app", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "website:true");
    expect(remembered.at(-1)).toBe(true);
    expect(remembered.filter(Boolean)).toHaveLength(1);
    await page.getByRole("button", { name: "Fetch quotes", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "website:allowed");
    await page.getByText("query1.finance.yahoo.com · allowed for this app").waitFor();
    await page.getByText("GET https://query1.finance.yahoo.com/v7/finance/quote?symbols=NVDA,AAPL").waitFor();
    await page.screenshot({ path: "/tmp/assistant-website-receipt.png" });
    // The app's secrets and approvals list the website and revoke it.
    await page.getByRole("button", { name: "Manage app approvals", exact: true }).click();
    await page.getByRole("button", { name: "Revoke the approval for query1.finance.yahoo.com", exact: true }).waitFor();
    await page.screenshot({ path: "/tmp/assistant-app-approvals.png" });
    await page.getByRole("button", { name: "Revoke the approval for query1.finance.yahoo.com", exact: true }).click();
    await page.getByText("Nothing is allowed without asking.").waitFor();
    expect(revoked).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60000);
