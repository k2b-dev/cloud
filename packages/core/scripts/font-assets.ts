import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function buildFontAssets(publicDir: string): Promise<void> {
  const preset = fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css"));
  const presetCss = await readFile(preset, "utf8");
  const css = [presetCss.replaceAll("./fonts/", "/public/fonts/")];
  const fontsDir = resolve(publicDir, "fonts");
  await mkdir(fontsDir, { recursive: true });
  const presetAssets = new Set([...presetCss.matchAll(/url\(\.\/fonts\/([^()]+\.woff2)\)/g)].map((match) => match[1]!));
  if (!presetAssets.size || presetCss.includes("data:")) throw new Error("Plex preset must reference external WOFF2 assets");
  await Promise.all([...presetAssets].map((asset) => cp(resolve(dirname(preset), "fonts", asset), resolve(fontsDir, asset))));

  for (const weight of ["400", "500", "600", "700"]) {
    const sourcePath = fileURLToPath(import.meta.resolve(`@fontsource/ibm-plex-sans-condensed/${weight}.css`));
    const sourceCss = await readFile(sourcePath, "utf8");
    const assets = [...sourceCss.matchAll(/url\(\.\/files\/([^)"']+\.woff2)\)/g)].map((match) => match[1]!);
    if (assets.length === 0) throw new Error(`IBM Plex Sans Condensed ${weight} does not reference a WOFF2 asset`);
    await Promise.all(assets.map((asset) => cp(resolve(dirname(sourcePath), "files", asset), resolve(fontsDir, asset))));
    css.push(
      sourceCss
        .replace(/,\s*url\([^)]+\.woff\)\s*format\(['"]woff['"]\)/g, "")
        .replace(/url\(\.\/files\/([^)"']+\.woff2)\)/g, (_match, asset: string) => `url("/public/fonts/${asset}")`),
    );
  }

  await writeFile(resolve(publicDir, "fonts.css"), css.join("\n"));
}
