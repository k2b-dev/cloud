import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildTablerIconAssets(publicDir: string): Promise<void> {
  const sourceCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const sourceCssPath = fileURLToPath(sourceCssUrl);
  const sourceCss = await readFile(sourceCssPath, "utf8");
  const fontAsset = sourceCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  const fontPath = fileURLToPath(new URL(fontAsset, sourceCssUrl));
  const font = await readFile(fontPath);
  const hash = createHash("sha256").update(font).digest("hex");
  const filename = `tabler-icons-${hash}.woff2`;
  const css = sourceCss.replace(fontAsset, `/public/fonts/${filename}`);
  await mkdir(resolve(publicDir, "fonts"), { recursive: true });

  await Promise.all([
    writeFile(resolve(publicDir, "tabler-icons.css"), `${css}\n`),
    writeFile(resolve(publicDir, "fonts", filename), font),
    // Keep the old address for CSS cached before this release; new CSS only references the content version.
    cp(fontPath, resolve(publicDir, "tabler-icons.woff2")),
  ]);
}
