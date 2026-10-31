import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

for (const mode of ["development", "production"] as const) {
  test(`public SSR renders its own template and serves the app's single island build in ${mode}`, async () => {
    const temporary = resolve(import.meta.dir, "../../.local");
    await mkdir(temporary, { recursive: true });
    const root = await mkdtemp(join(temporary, "public-ssr-"));
    try {
      await mkdir(join(root, "src"));
      const defineApp = resolve(import.meta.dir, "define-app.ts");
      const publicSurface = resolve(import.meta.dir, "public-surface.ts");
      await writeFile(
        join(root, "src", "config.ts"),
        `
        import { defineApp } from ${JSON.stringify(defineApp)};
        export const app = defineApp({ id: "public-probe", name: "Public probe", icon: "ti ti-world", description: "Public site", public: true,
          appRoot: ${JSON.stringify(root)}, basePath: "/app/public-probe", baseUrl: "http://upstream:3000", routes: ["/app/public-probe"] });
        export const site = app.publicSsr<{ title: string }>(({ body, scripts, title }) =>
          '<!doctype html><html lang="en"><head><title>'+Bun.escapeHTML(title)+'</title><link rel="stylesheet" href="/site.css"></head><body>'+body+scripts+'</body></html>');
      `,
      );
      await writeFile(
        join(root, "src", "Counter.island.tsx"),
        'import { createSignal } from "solid-js"; export default function Counter() { const [count, setCount] = createSignal(0); return <button onClick={() => setCount(count() + 1)}>Count {count()}</button>; }',
      );
      await writeFile(
        join(root, "src", "Page.tsx"),
        'import Counter from "./Counter.island"; export default () => <main><h1>Public page</h1><Counter /></main>;',
      );
      await writeFile(
        join(root, "src", "server.tsx"),
        `
        import { Hono } from "hono";
        import { app, site } from "./config";
        import Page from "./Page";
        import { createPublicSurfaceHandler } from ${JSON.stringify(publicSurface)};
        app.public.get("/", () => site.html(() => <Page />, { title: "Own template" }));
        app.public.get("/site.css", (c) => c.body("body{color:navy}", 200, { "Content-Type": "text/css" }));
        const handler = createPublicSurfaceHandler(app.public, ${mode === "development"});
        const router = new Hono().all("/_cloud/public", handler).all("/_cloud/public/*", handler);
        const headers = { "X-Cloud-Public-Host": "public-probe.localhost:3100" };
        const response = await router.request("/_cloud/public/", { headers });
        const html = await response.text();
        const id = html.match(/<solid-island data-id="([^"]+)"/)?.[1];
        const assets = html.match(/data-ssr-assets="([^"]+)"/)?.[1];
        const asset = await router.request('/_cloud/public'+assets+'/'+id+'.js', { headers });
        const css = await router.request("/_cloud/public/site.css", { headers });
        const manifest = await router.request("/_cloud/public/_ssr/manifest.json", { headers });
        console.log(JSON.stringify({ status: response.status, html, assets, id, assetStatus: asset.status, assetType: asset.headers.get("content-type"), assetCache: asset.headers.get("cache-control"), assetBytes: (await asset.text()).length, css: await css.text(), manifestStatus: manifest.status }));
      `,
      );
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", resolve(import.meta.dir, "public-surface-ssr.test-fixture.ts"), root, mode],
        {
          cwd: resolve(import.meta.dir, "../.."),
          env: { ...process.env, NODE_ENV: mode },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 35000,
        },
      );
      let stdout: string, stderr: string, exitCode: number;
      try {
        [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
      } finally {
        if (child.exitCode === null) {
          child.kill();
          await child.exited;
        }
      }
      expect({ exitCode, errors: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, errors: "" });
      const result = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(result.status).toBe(200);
      expect(result.html).toContain("<title>Own template</title>");
      expect(result.html).toContain("Count 0");
      expect(result.html).toContain('href="/site.css"');
      expect(result.html).not.toContain("/public/global.css");
      expect(result.id).toMatch(/^[a-f0-9]+$/);
      expect(result.assets).toMatch(mode === "development" ? /^\/_ssr$/ : /^\/_ssr\/[a-f0-9]{16}$/);
      expect(result.assetStatus).toBe(200);
      expect(result.assetType).toContain("javascript");
      expect(result.assetBytes).toBeGreaterThan(0);
      if (mode === "production") expect(result.assetCache).toBe("public, max-age=31536000, immutable");
      expect(result.css).toBe("body{color:navy}");
      expect(result.manifestStatus).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 40000);
}
