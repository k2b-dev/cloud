import { cp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildTablerIconAssets(publicDir: string): Promise<void> {
  const sourceCssUrl = import.meta.resolve("@k2b/ui/icons/tabler.css");
  const sourceCssPath = fileURLToPath(sourceCssUrl);
  const sourceCss = await readFile(sourceCssPath, "utf8");
  const fontAsset = sourceCss.match(/url\((\.\/[^)"']+\.woff2(?:[?#][^)"']*)?)\)/)?.[1];
  if (!fontAsset) throw new Error("@k2b/ui Tabler preset does not reference a WOFF2 asset");
  const css = sourceCss.replace(fontAsset, "/public/tabler-icons.woff2");

  await Promise.all([
    writeFile(resolve(publicDir, "tabler-icons.css"), `${css}\n`),
    cp(fileURLToPath(new URL(fontAsset, sourceCssUrl)), resolve(publicDir, "tabler-icons.woff2")),
  ]);
}
