import { expect, test } from "bun:test";
import { launchBrowser, settled } from "../../../ui/test/browser";
import { SecretSave } from "./http-contracts";
import { MachineRights } from "./machine-contracts";

test("Studio machine rights recover from load/save failure and fit phone, tablet, desktop and dark", async () => {
  const build = Bun.spawn(
    [process.execPath, new URL("./workspace-browser-build.ts", import.meta.url).pathname, "./machine-permissions-browser-harness.tsx"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const tailwind = (await import(Bun.resolveSync("bun-plugin-tailwind", new URL("../../../ui/", import.meta.url).pathname))).default;
  const [code, buildError, styles, appStyles] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    Bun.build({ entrypoints: [new URL("../../../../styles.css", import.meta.url).pathname], plugins: [tailwind] }),
    Bun.build({ entrypoints: [new URL("../styles/app.css", import.meta.url).pathname], plugins: [tailwind] }),
  ]);
  if (await build.exited) throw new Error(buildError);
  if (!styles.success || !appStyles.success) throw new AggregateError([...styles.logs, ...appStyles.logs], "Stylesheets did not build.");
  const css = (await styles.outputs[0]!.text()) + (await appStyles.outputs[0]!.text());
  const policy = (id: string, kind: "agent" | "standalone", name: string) => ({
    entry: {
      id,
      principal: {
        type: "service_account",
        serviceAccountId: kind === "agent" ? "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" : "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
      permission: "read",
      displayName: name,
      serviceAccountKind: kind,
      createdAt: "2026-10-23T12:00:00.000Z",
    },
    rights: MachineRights.parse(
      kind === "agent"
        ? {
            execute: true,
            storage: "write",
            database: "read",
            secrets: ["reportApi"],
            http: [{ origin: "https://api.example.com", methods: ["GET"] }],
          }
        : {},
    ),
    revision: "44444444-4444-4444-8444-444444444444",
    status: kind === "agent" ? "active" : "disabled",
  });
  const policies = [
    policy("22222222-2222-4222-8222-222222222222", "agent", "Invoice agent"),
    policy("33333333-3333-4333-8333-333333333333", "standalone", "Reporting service"),
  ];
  let failLoad = true,
    failSave = true;
  const writes: unknown[] = [];
  const secretEntries: { name: string; origin: string; header: string; prefix: string; configured: true; revision: string }[] = [];
  let failSecretSave = true;
  let waitForLoad: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js") return new Response(code, { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/ui.css") return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname.endsWith("/secrets")) {
        if (request.method === "PUT") {
          if (failSecretSave) return Response.json({ code: "CONFLICT" }, { status: 409 });
          const { value: _value, expectedRevision: _revision, ...metadata } = SecretSave.parse(await request.json());
          const entry = { ...metadata, configured: true as const, revision: "55555555-5555-4555-8555-555555555555" };
          secretEntries.push(entry);
          return Response.json(entry);
        }
        return Response.json(secretEntries);
      }
      if (url.pathname.endsWith("/access")) {
        await waitForLoad;
        return failLoad ? Response.json({ code: "UNAVAILABLE" }, { status: 503 }) : Response.json(policies);
      }
      if (request.method === "PUT" && url.pathname.includes("/access/")) {
        const body = await request.json();
        writes.push(body);
        if (failSave) return Response.json({ code: "CONFLICT" }, { status: 409 });
        policies[0]!.rights = MachineRights.parse(body.rights);
        return Response.json({ rights: policies[0]!.rights, revision: policies[0]!.revision });
      }
      const theme = /theme=dark/.test(request.headers.get("cookie") ?? "") ? "dark" : "light";
      return new Response(
        `<!doctype html><html lang="en" class="${theme}" data-theme="${theme}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui.css"><body class="k2b-ui"><div id="root"></div><script src="/bundle.js"></script></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    await page.getByText("Machine rights could not be loaded.", { exact: true }).waitFor();
    failLoad = false;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    const controls = page.getByRole("region", { name: "Machine execution", exact: true });
    await controls.getByText("Invoice agent", { exact: true }).waitFor();
    await controls.getByText(/Account disabled/).waitFor();
    const execute = controls.getByRole("checkbox", { name: "Execute published code", exact: true }).first();
    await execute.uncheck();
    await controls.getByRole("button", { name: "Save rights", exact: true }).first().click();
    await controls.getByText(/Could not save/).waitFor();
    expect(await execute.isChecked()).toBe(false);
    failSave = false;
    await controls.getByRole("button", { name: "Save rights", exact: true }).first().click();
    await controls
      .getByText(/Execution is off/)
      .first()
      .waitFor();
    expect(writes).toHaveLength(2);
    const secretControls = page.getByRole("region", { name: "App machine secrets", exact: true });
    await secretControls.getByRole("button", { name: "Add machine secret", exact: true }).click();
    await secretControls.getByLabel("Secret name", { exact: true }).fill("reportApi");
    await secretControls.getByLabel("HTTPS origin", { exact: true }).fill("https://api.example.com");
    const secretValue = secretControls.getByLabel("Secret value", { exact: true });
    await secretValue.fill("fictional-only");
    await secretControls.getByRole("button", { name: "Save secret", exact: true }).click();
    await secretControls.getByText(/Could not save/).waitFor();
    expect(await secretValue.inputValue()).toBe("fictional-only");
    failSecretSave = false;
    await secretControls.getByRole("button", { name: "Save secret", exact: true }).click();
    await secretControls.getByRole("button", { name: "Replace secret", exact: true }).waitFor();
    expect(await secretValue.count()).toBe(0);
    await secretControls.getByRole("button", { name: "Replace secret", exact: true }).click();
    expect(await secretValue.inputValue()).toBe("");
    await secretControls.getByRole("button", { name: "Cancel", exact: true }).click();
    for (const width of [390, 820, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await settled(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const layout = await page.locator("main").evaluate((main) => ({
        display: getComputedStyle(main).display,
        direction: getComputedStyle(main).flexDirection,
        width: main.getBoundingClientRect().width,
      }));
      expect(layout.display).toBe("flex");
      expect(layout.direction).toBe("column");
      if (width === 1440) expect(layout.width).toBeLessThan(900);
    }
    // Optional screenshot capture stays private; the worker has no publication authority.
    if (process.env.STUDIO_SCREENSHOT_DIR) {
      const shot = Bun.spawn(
        [
          "dev",
          "shot",
          `studio-permissions=${server.url.href}`,
          "--out",
          process.env.STUDIO_SCREENSHOT_DIR,
          "--widths",
          "390,820,1440",
          "--themes",
          "light,dark",
          "--theme-cookie",
          "theme",
          "--full-page",
          "--wait-for",
          '[aria-label="App machine secrets"]',
          "--json",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      if (await shot.exited) throw new Error(await new Response(shot.stderr).text());
    }
    const loading = Promise.withResolvers<void>();
    waitForLoad = loading.promise;
    await page.reload();
    await page.getByText("Loading machine rights…", { exact: true }).first().waitFor();
    policies.length = 0;
    secretEntries.length = 0;
    loading.resolve();
    await page
      .getByText("No agents or service accounts have access. Add one above, then choose its execution rights.", { exact: true })
      .waitFor();
    await page.reload();
    await page.getByText("No app machine secrets configured.", { exact: true }).waitFor();
    expect(errors).toEqual([]);
  } finally {
    try {
      await browser?.close();
    } finally {
      await server.stop(true);
    }
  }
}, 60000);
