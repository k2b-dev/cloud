import { expect, test } from "bun:test";

// The app SEO checklist from build/public-surface.md, checked on the example's public surface in a child
// process with the example's own SSR plugin. scripts/lighthouse-public-site.ts measures it in a browser.
test("the public site meets the app SEO checklist on its assigned domain", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const surface = new URL("../../../src/_internal/public-surface.ts", import.meta.url).pathname;
  const script = `
    import { strict as assert } from "node:assert";
    const { app } = await import(${JSON.stringify(`${root}src/config.ts`)});
    Bun.plugin(app.plugin());
    await import(${JSON.stringify(`${root}src/site.tsx`)});
    const { createPublicSurfaceHandler } = await import(${JSON.stringify(surface)});
    const { Hono } = await import("hono");
    // Mounted the way the platform mounts app.public; the gateway supplies the assigned domain.
    const handler = createPublicSurfaceHandler(app.public, false);
    const router = new Hono().all("/_cloud/public", handler).all("/_cloud/public/*", handler);
    const get = (path, headers = {}) =>
      router.request("/_cloud/public" + path, { headers: { "X-Cloud-Public-Host": "www.lindenhof.example", ...headers } });
    const home = await get("/");
    const html = await home.text();
    assert.equal(home.status, 200);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<title>[^<]+<\\/title>/);
    assert.match(html, /<meta name="description" content="[^"]+">/);
    assert.match(html, /<link rel="canonical" href="https:\\/\\/www\\.lindenhof\\.example\\/">/);
    assert.match(html, /hreflang="de" href="https:\\/\\/www\\.lindenhof\\.example\\/de\\/"/);
    assert.match(html, /hreflang="x-default" href="https:\\/\\/www\\.lindenhof\\.example\\/"/);
    assert.match(html, /<meta property="og:url" content="https:\\/\\/www\\.lindenhof\\.example\\/">/);
    assert.match(html, /<script type="application\\/ld\\+json">\\{"@context":"https:\\/\\/schema\\.org","@type":"Bakery"/);
    // Solid renders the empty alt of a decorative image as a bare attribute.
    assert.match(html, /<img src="\\/assets\\/logo\\.[a-z0-9]+\\.svg" alt width="48" height="48">/);
    assert.match(html, /<h1>Lindenhof Bakery<\\/h1>/, "content is in the SSR HTML");
    assert.match(html, /<solid-island/, "the share button is an island");
    assert.equal(home.headers.get("Cache-Control"), "public, max-age=60");
    const tag = home.headers.get("ETag");
    assert.ok(tag);
    assert.equal((await get("/", { "If-None-Match": tag })).status, 304);
    const de = await (await get("/de/")).text();
    assert.match(de, /<html lang="de">/);
    assert.match(de, /<link rel="canonical" href="https:\\/\\/www\\.lindenhof\\.example\\/de\\/">/);
    const robots = await (await get("/robots.txt")).text();
    assert.match(robots, /^Sitemap: https:\\/\\/www\\.lindenhof\\.example\\/sitemap\\.xml$/m);
    const sitemap = await (await get("/sitemap.xml")).text();
    assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\\/loc>/g)].map((m) => m[1]), ["https://www.lindenhof.example/", "https://www.lindenhof.example/de/"]);
    const logo = html.match(/src="(\\/assets\\/logo\\.[a-z0-9]+\\.svg)"/)[1];
    assert.equal((await get(logo)).headers.get("Cache-Control"), "public, max-age=31536000, immutable");
    const moved = await get("/opening-hours");
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get("Location"), "/");
    assert.equal((await get("/christmas-2025")).status, 410);
    assert.equal((await get("/missing")).status, 404);
    console.log("checklist passed");
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    cwd: root,
    env: { ...process.env, NODE_ENV: "development" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }).toEqual({ exitCode: 0, output: "" });
}, 60_000);
