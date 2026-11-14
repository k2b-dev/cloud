import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Serves the @k2b/ui icon preset from Core: every WOFF2 file it references, one per font face, under a content
 * version. Tabler 3.48 has one face; from 3.50 the font is split into unicode-range faces.
 */
export async function buildTablerIconAssets(publicDir: string): Promise<void> {
  const sourceCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const sourceCssPath = fileURLToPath(sourceCssUrl);
  let css = await readFile(sourceCssPath, "utf8");
  const fontAssets = new Set([...css.matchAll(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/g)].map((match) => match[1]!));
  if (fontAssets.size === 0) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  await mkdir(resolve(publicDir, "fonts"), { recursive: true });

  for (const fontAsset of fontAssets) {
    const font = await readFile(fileURLToPath(new URL(fontAsset, sourceCssUrl)));
    const filename = `tabler-icons-${createHash("sha256").update(font).digest("hex")}.woff2`;
    await writeFile(resolve(publicDir, "fonts", filename), font);
    css = css.replaceAll(`url(${fontAsset})`, `url(/public/fonts/${filename})`);
  }
  await writeFile(resolve(publicDir, "tabler-icons.css"), `${css}\n`);

  // Keep the old address, with the complete font, for CSS cached before the content versions; new CSS only
  // references those.
  const webfont = dirname(Bun.resolveSync("@tabler/icons-webfont/package.json", dirname(sourceCssPath)));
  await cp(resolve(webfont, "dist/fonts/tabler-icons.woff2"), resolve(publicDir, "tabler-icons.woff2"));
}
