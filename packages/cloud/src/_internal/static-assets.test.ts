import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

// The handler serves `public/` below the working directory.
const root = mkdtempSync(join(tmpdir(), "cloud-static-assets-"));
mkdirSync(join(root, "public"));
const css = join(root, "public", "global.css");
writeFileSync(css, "body{color:red}");
const cwd = process.cwd();
process.chdir(root);
const { servePublicAsset } = await import("./static-assets");
afterAll(() => {
  process.chdir(cwd);
  rmSync(root, { recursive: true, force: true });
});

const serve = (isDevelopment: boolean) => new Hono().all("/public/*", servePublicAsset(isDevelopment));

describe("public assets", () => {
  test("in development, an unchanged file costs one round trip instead of its whole size", async () => {
    const app = serve(true);
    const first = await app.request("/public/global.css");
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-cache");
    expect(await first.text()).toBe("body{color:red}");
    const etag = first.headers.get("ETag")!;

    const again = await app.request("/public/global.css", { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get("ETag")).toBe(etag);
    expect(await again.text()).toBe("");

    // A rebuild under the same address is new content.
    writeFileSync(css, "body{color:blue}");
    utimesSync(css, new Date(), new Date(Date.now() + 5_000));
    const rebuilt = await app.request("/public/global.css", { headers: { "If-None-Match": etag } });
    expect(rebuilt.status).toBe(200);
    expect(await rebuilt.text()).toBe("body{color:blue}");
  });

  test("in production, files stay cached for good", async () => {
    const response = await serve(false).request("/public/global.css");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });
});
