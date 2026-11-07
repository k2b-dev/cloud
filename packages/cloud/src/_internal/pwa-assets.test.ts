import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPwaStaticAsset } from "../contracts/pwa-assets";
import { readPwaStaticAssets } from "./pwa-assets";

// Build outputs, not names supplied by pages, define the trusted body digests.
test("the catalog hashes final SSR chunks and versioned CSS, excluding data and stable font URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pwa-static-catalog-"));
  try {
    await mkdir(join(root, "_ssr"));
    await mkdir(join(root, "public/core"), { recursive: true });
    await writeFile(join(root, "_ssr/manifest.json"), JSON.stringify({ version: "0123456789abcdef", entries: {} }));
    await writeFile(join(root, "_ssr/123456789012.js"), "final rewritten JavaScript");
    await writeFile(join(root, "_ssr/chunk-opaque.js"), "export const x = 1;");
    await writeFile(join(root, "public/global.css"), "body{color:blue}");
    await writeFile(join(root, "public/core/app.css"), "body{color:red}");
    await writeFile(join(root, "public/tabler-icons.woff2"), "stable font");
    const font = "versioned font";
    const fontHash = createHash("sha256").update(font).digest("hex").slice(0, 16);
    await writeFile(join(root, `public/plex-${fontHash}.woff2`), font);
    await writeFile(join(root, "public/fake-aaaaaaaaaaaaaaaa.woff2"), font);
    await writeFile(join(root, "public/private.html"), "private page");
    await writeFile(join(root, "public/data.json"), "{}");
    const assets = await readPwaStaticAssets(root, "core", "/app/core/_ssr", "release-1");
    expect(assets.map((a) => a.url)).toEqual([
      "/app/core/_ssr/0123456789abcdef/123456789012.js",
      "/app/core/_ssr/0123456789abcdef/chunk-opaque.js",
      expect.stringMatching(/^\/public\/core\/app.css\?v=[a-f0-9]{16}$/),
      "/public/global.css?v=release-1",
      `/public/plex-${fontHash}.woff2`,
    ]);
    expect(assets[0]!.sha256).toBe(createHash("sha256").update("final rewritten JavaScript").digest("hex"));
    expect(assets.every(isPwaStaticAsset)).toBe(true);
    expect((await readPwaStaticAssets(root, "core", "/app/core/_ssr", "local")).some((a) => a.url.startsWith("/public/global.css"))).toBe(
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only versioned static URLs and bounded cryptographic metadata pass the catalog boundary", () => {
  const base = { url: "/chat/_ssr/0123456789abcdef/chunk.js", sha256: "a".repeat(64), bytes: 100, type: "text/javascript" };
  expect(isPwaStaticAsset(base)).toBe(true);
  for (const url of [
    "/api/chat",
    "/pwa/../api/_ssr/0123456789abcdef/chunk.js",
    "/%61pi/_ssr/0123456789abcdef/chunk.js",
    "/api/_ssr/0123456789abcdef/chunk.js",
    "/pwa/chat",
    "//other.test/file.js",
    "/public/app.css",
    "/chat/_ssr/0123456789abcdef/page.html",
  ])
    expect(isPwaStaticAsset({ ...base, url })).toBe(false);
  for (const bytes of [-1, 0, 0.5, Infinity, 16 * 1024 * 1024 + 1]) expect(isPwaStaticAsset({ ...base, bytes })).toBe(false);
  expect(isPwaStaticAsset({ ...base, type: "text/html" })).toBe(false);
  expect(isPwaStaticAsset({ ...base, sha256: "not-a-content-hash" })).toBe(false);
});
