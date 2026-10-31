import { expect, test } from "bun:test";
import { validateNetworkAllowlist } from "@k2b/cloud/services/settings/validation";
import { launchBrowser } from "../../../ui/test/browser";

test("Studio administration renders inventory and tests settings without saving secrets", async () => {
  const build = Bun.spawn(["bun", new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./admin-browser-harness.tsx"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await new Response(build.stdout).text();
  if (await build.exited) throw new Error(await new Response(build.stderr).text());
  // The shipped stylesheets compile through Cloud's Tailwind plugin, so the dialog shows its real spacing.
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../cloud/", import.meta.url).pathname))).default;
  const css = await Bun.build({ entrypoints: [new URL("../../../../styles.css", import.meta.url).pathname], plugins: [tailwind] });
  if (!css.success) throw new AggregateError(css.logs, "Could not compile the stylesheets");
  const styles = await css.outputs[0]!.text();
  const writes: unknown[] = [],
    tests: unknown[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/bundle.js") return new Response(code, { headers: { "Content-Type": "text/javascript" } });
      if (path === "/ui.css") return new Response(styles, { headers: { "Content-Type": "text/css; charset=utf-8" } });
      if (path.endsWith("/database/settings") || path.endsWith("/database/test")) {
        const body = request.method === "GET" ? {} : ((await request.json()) as { allowedTargets?: string[] });
        // The same check the server runs before it tests or stores a list.
        if (body.allowedTargets && validateNetworkAllowlist(body.allowedTargets))
          return Response.json(
            { code: "DB_TARGETS_INVALID", message: "Enter exact host names, IP addresses or CIDR ranges. A /0 range is not allowed." },
            { status: 400 },
          );
        if (path.endsWith("/database/test")) {
          tests.push(body);
          return Response.json({ connected: true });
        }
        if (request.method === "PUT") writes.push(body);
        return Response.json({
          url: "http://database.test",
          tokenSet: true,
          allowedTargets: ["rsql"],
          unreadable: { "assistant.rsql_url": false, "assistant.rsql_api_token": false, "assistant.rsql_allowed_targets": false },
        });
      }
      if (path.endsWith("/access")) return Response.json([]);
      return new Response(
        '<!doctype html><html class="light"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui.css"><body class="k2b-ui"><div id="root"></div><script type="module" src="/bundle.js"></script>',
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  const browser = await launchBrowser();
  const shots = process.env.ADMIN_SETTINGS_SHOTS;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
    expect(await dialog.getByText("Changes apply to new requests.").isVisible()).toBe(true);
    if (shots) await page.screenshot({ path: `${shots}/assistant-database-1440.png`, animations: "disabled" });
    await dialog.getByRole("button", { name: "Test connection", exact: true }).click();
    await dialog.getByText("Connection successful", { exact: true }).waitFor();
    // A test checks the drafted list of allowed targets with the address.
    expect(tests).toEqual([{ url: "http://database.test", allowedTargets: ["rsql"], replaceUnreadable: [] }]);
    expect(writes).toEqual([]);

    // A list the server refuses keeps its reason at the field, not in the dialog's error notice.
    const targets = dialog.getByRole("textbox", { name: /^rsql allowed targets/ });
    await targets.fill("rsql, 0.0.0.0/0");
    await targets.blur();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.getByText(/A \/0 range is not allowed/).waitFor();
    expect(await targets.getAttribute("aria-invalid")).toBe("true");
    if (shots) await page.screenshot({ path: `${shots}/assistant-database-refused-1440.png`, animations: "disabled" });
    expect(writes).toEqual([]);

    await targets.fill("rsql, 10.20.0.0/16");
    await targets.blur();
    expect(await targets.getAttribute("aria-invalid")).toBeNull();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    // Only the changed list is stored; the unchanged address and token stay as they are.
    expect(writes).toEqual([{ allowedTargets: ["rsql", "10.20.0.0/16"], replaceUnreadable: [] }]);
    await page.getByRole("button", { name: "Manage access", exact: true }).click();
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.goto(server.url.href);
    await phone.getByRole("button", { name: "Database settings", exact: true }).click();
    await phone
      .getByRole("dialog")
      .getByRole("textbox", { name: /^rsql allowed targets/ })
      .waitFor();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (shots) await phone.screenshot({ path: `${shots}/assistant-database-390.png`, animations: "disabled" });
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 60000);
