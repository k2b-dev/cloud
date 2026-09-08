import { dirname, resolve } from "node:path";
import subsetFont from "subset-font";

/** Preserve Tabler's glyphs and CSS API, shipping only names present in emitted JavaScript. */
export async function iconStyles(javascript: string) {
  const uiRoot = dirname(Bun.resolveSync("@k2b/ui/package.json", import.meta.dir));
  const tablerRoot = dirname(Bun.resolveSync("@tabler/icons-webfont/package.json", uiRoot));
  const css = await Bun.file(resolve(tablerRoot, "dist/tabler-icons.css")).text();
  const names = new Set(javascript.match(/ti-[a-z0-9-]+/g));
  const rules = [...css.matchAll(/\.([\w-]+):before\s*\{\s*content:\s*"\\([0-9a-f]+)";\s*\}/g)].filter((match) => names.has(match[1]!));
  const characters = rules.map((match) => String.fromCodePoint(Number.parseInt(match[2]!, 16))).join("");
  if (!characters) throw new Error("No Tabler glyphs found for PWA");
  const font = await subsetFont(
    Buffer.from(await Bun.file(resolve(tablerRoot, "dist/fonts/tabler-icons.woff2")).arrayBuffer()),
    characters,
    {
      targetFormat: "woff2",
    },
  );
  const base = css.match(/\.ti\s*\{[^}]+\}/)?.[0];
  if (!base) throw new Error("Missing Tabler base style");
  console.log(`Tabler subset: ${rules.length} icons, ${font.length} bytes`);
  return `@font-face{font-family:tabler-icons;font-style:normal;font-weight:400;font-display:block;src:url(data:font/woff2;base64,${font.toString("base64")}) format("woff2")}\n${base}\n${rules.map((match) => match[0]).join("\n")}`;
}
