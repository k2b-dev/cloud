import { expect, test } from "bun:test";

test("SSR uses the actual scope for head, safe area, localized runtime and errors, without an app layout hook", async () => {
  const module = (path: string) => JSON.stringify(new URL(path, import.meta.url).pathname);
  const script = `
    import { strict as assert } from "node:assert";
    import { mkdtempSync, rmSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { resolve } from "node:path";
    import { createConfig } from "@k2b/ssr";
    import { Hono } from "hono";
    const root = mkdtempSync(resolve(tmpdir(), "cloud-installable-head-"));
    const { plugin } = createConfig({ dev: true, rootDir: root });
    Bun.plugin(plugin());
    const { defineApp } = await import(${module("./define-app.ts")});
    const { kiosk } = await import(${module("./installable.test-fixture.ts")});
    const options = { id: "inventory", name: "Inventory", icon: "ti ti-box", description: "Counter", baseUrl: "http://inventory:3000", routes: ["/app/inventory"], basePath: "/app/inventory", installable: { ...kiosk, shortName: 'Counter "&"' }, pwa: {} };
    const app = defineApp(options);
    const page = app.ssr(() => () => "app-owned content");
    const server = new Hono().get("/app/inventory/counter/", ...page).get("/app/inventory/counter/document/1", ...page)
      .get("/app/inventory/counterfeit/", ...page).get("/app/inventory", ...page).get("/pwa/inventory", ...page)
      .get("/app/inventory/counter/forbidden", (c) => app.ssr.error(c, 403, { layout: "minimal" }));
    try {
      for (const path of [kiosk.path, kiosk.path + "document/1", kiosk.path + "forbidden"]) {
        const response = await server.request(path, { headers: { Cookie: "theme=dark; cloud.locale=de" } });
        const html = await response.text();
        assert.equal(response.status, path.endsWith("forbidden") ? 403 : 200);
        assert.ok(html.includes('<html lang="de" class="dark"'));
        assert.ok(html.includes('content="width=device-width, initial-scale=1, viewport-fit=cover"'));
        assert.ok(html.includes('data-app-pwa-manifest href="/app/inventory/counter/manifest.webmanifest?theme=dark"'));
        assert.ok(html.includes('data-app-pwa-apple href="/app/inventory/counter/apple-touch-icon-dark.png"'));
        assert.ok(html.includes('data-app-pwa-theme content="#090d12"'));
        assert.ok(html.includes('content="Counter &quot;&amp;&quot;"'));
        assert.ok(html.includes('env(safe-area-inset-bottom)'));
        assert.ok(html.includes('data-app-pwa-runtime'));
        assert.ok(html.includes('solid-island'));
        assert.ok(!html.includes('/pwa/manifest.webmanifest'));
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
      }
      for (const path of ["/app/inventory", "/app/inventory/counterfeit/", "/pwa/inventory"]) {
        const html = await (await server.request(path)).text();
        assert.ok(!html.includes('data-app-pwa-manifest'));
        assert.ok(!html.includes('data-app-pwa-runtime'));
      }
      const light = await (await server.request(kiosk.path)).text();
      assert.ok(light.includes('manifest.webmanifest?theme=light'));
      assert.ok(light.indexOf('cloud:theme-preference') < light.indexOf("document.querySelector('meta[data-app-pwa-theme]')"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: new URL("../..", import.meta.url).pathname,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }).toEqual({ exitCode: 0, output: "" });
}, 30_000);
