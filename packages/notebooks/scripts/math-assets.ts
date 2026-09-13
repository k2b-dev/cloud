import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { katexAssetDirectory } from "../src/lib/katex-assets";

export async function buildMathAssets(publicDir: string): Promise<void> {
  const source = Bun.resolveSync("katex/dist/katex.min.css", import.meta.dir);
  const css = (await readFile(source, "utf8"))
    .replace(/,url\([^)]*\.woff\)\s*format\("woff"\)/g, "")
    .replace(/,url\([^)]*\.ttf\)\s*format\("truetype"\)/g, "");
  const assets = new Set([...css.matchAll(/url\(fonts\/([^()]+\.woff2)\)/g)].map((match) => match[1]!));
  if (!assets.size || /\.woff\)|\.ttf\)|data:/.test(css)) throw new Error("Unexpected KaTeX font sources");
  const output = resolve(publicDir, "notebooks", katexAssetDirectory);
  await mkdir(resolve(output, "fonts"), { recursive: true });
  await Promise.all([...assets].map((asset) => cp(resolve(dirname(source), "fonts", asset), resolve(output, "fonts", asset))));
  await writeFile(resolve(output, "katex.css"), css);
}
