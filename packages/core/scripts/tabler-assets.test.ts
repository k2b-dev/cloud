import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readPwaStaticAssets } from "../../cloud/src/_internal/pwa-assets";
import { buildTablerIconAssets } from "./tabler-assets";

test("shipped icon CSS names every font file by its content and the verified catalog includes them", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-tabler-assets-"));
  try {
    const publicDir = join(root, "public");
    await mkdir(publicDir);
    await buildTablerIconAssets(publicDir);
    const css = await readFile(join(publicDir, "tabler-icons.css"), "utf8");
    const sourceCssPath = fileURLToPath(import.meta.resolve("@k2b/ui/icons/tabler.css"));
    const sourceFonts = [...(await readFile(sourceCssPath, "utf8")).matchAll(/url\((\.\/[^)"']+\.woff2[^)"']*)\)/g)].map(
      (match) => match[1]!,
    );

    // Each font face keeps its own file, now under its content version; no relative font address is left.
    const urls = [...css.matchAll(/url\(([^)"']+\.woff2)\)/g)].map((match) => match[1]!);
    expect(urls.length).toBe(sourceFonts.length);
    expect(urls.length).toBeGreaterThan(0);
    expect(css).not.toMatch(/url\(\.\/[^)]*\.woff2/);
    const assets = await readPwaStaticAssets(root, "core", "/_ssr", "release-test");
    for (const [index, url] of urls.entries()) {
      const font = await readFile(join(publicDir, url.slice("/public/".length)));
      const sha256 = createHash("sha256").update(font).digest("hex");
      expect(url).toBe(`/public/fonts/tabler-icons-${sha256}.woff2`);
      expect(font).toEqual(await readFile(join(dirname(sourceCssPath), sourceFonts[index]!.replace(/[?#].*$/, ""))));
      expect(assets.find((asset) => asset.url === url)).toEqual({ url, sha256, bytes: font.byteLength, type: "font/woff2" });
    }

    // The old address keeps the complete font for CSS cached before content versions, outside the verified catalog.
    const webfont = dirname(Bun.resolveSync("@tabler/icons-webfont/package.json", dirname(sourceCssPath)));
    expect(await readFile(join(publicDir, "tabler-icons.woff2"))).toEqual(await readFile(join(webfont, "dist/fonts/tabler-icons.woff2")));
    expect(css).not.toContain("url(/public/tabler-icons.woff2)");
    expect(assets.some((asset) => asset.url === "/public/tabler-icons.woff2")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
