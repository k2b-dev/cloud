import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPwaStaticAssets } from "../../cloud/src/_internal/pwa-assets";
import { buildTablerIconAssets } from "./tabler-assets";

test("shipped icon CSS names the complete font by its content and the verified catalog includes it", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-tabler-assets-"));
  try {
    const publicDir = join(root, "public");
    await mkdir(publicDir);
    await buildTablerIconAssets(publicDir);
    const css = await readFile(join(publicDir, "tabler-icons.css"), "utf8");
    const font = await readFile(join(publicDir, "tabler-icons.woff2"));
    const sha256 = createHash("sha256").update(font).digest("hex");
    const url = `/public/fonts/tabler-icons-${sha256}.woff2`;
    expect(css.match(/url\(([^)]+)\)/)?.[1]).toBe(url);
    expect(css).not.toContain("url(/public/tabler-icons.woff2)");
    expect(await readFile(join(publicDir, url.slice("/public/".length)))).toEqual(font);
    const sourceCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
    const sourceCss = await readFile(new URL(sourceCssUrl), "utf8");
    const sourceFont = sourceCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
    expect(sourceFont).toBeDefined();
    expect(font).toEqual(await readFile(new URL(sourceFont!, sourceCssUrl)));
    const assets = await readPwaStaticAssets(root, "core", "/_ssr", "release-test");
    expect(assets.find((asset) => asset.url === url)).toEqual({ url, sha256, bytes: font.byteLength, type: "font/woff2" });
    expect(assets.some((asset) => asset.url === "/public/tabler-icons.woff2")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
