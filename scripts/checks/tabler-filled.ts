import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/** A Tabler class such as `ti-star-filled`, in markup, class lists and CSS. */
const filledClass = /\bti-[a-z0-9]+(?:-[a-z0-9]+)*-filled\b/g;
/** An icon name such as `"star-filled"`, as `Icon`, pickers and catalogs take it (never an attribute like `data-filled`). */
const filledName = /(["'`])(?!data-)([a-z0-9]+(?:-[a-z0-9]+)*-filled)\1/g;

/** The filled Tabler names a source mentions, with their lines. */
export const findFilledIcons = (source: string): { line: number; name: string }[] => {
  const hits: { line: number; name: string }[] = [];
  source.split("\n").forEach((text, index) => {
    for (const match of text.matchAll(filledClass)) hits.push({ line: index + 1, name: match[0] });
    for (const match of text.matchAll(filledName)) hits.push({ line: index + 1, name: match[2]! });
  });
  return hits;
};

/**
 * Cloud ships Tabler's outline font only (`@k2b/ui/icons/tabler.css`), so a `*-filled` name draws nothing: the star of a
 * rating, a pin or a play mark stood as an empty box (#4558). Shipped code names outline icons; where the filled shape
 * carries the meaning (a rating star), it draws its own small SVG. Tests may name a filled class to prove it is gone.
 */
export const rule: Rule = {
  name: "tabler-filled",
  description: "Shipped code names no Tabler *-filled icon, because the icon preset carries only the outline font",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const roots = [join(workspaceRoot, "packages"), join(workspaceRoot, "docs-site", "src")];
    for (const root of roots)
      for (const path of listFiles(root, /\.(?:ts|tsx|css)$/)) {
        if (isTestFile(path) || !/\/src\//.test(path) || path.includes("/node_modules/")) continue;
        // the icon preset maps the two filled names that records may still hold to their outline glyphs
        if (relative(workspaceRoot, path) === "packages/ui/src/icons/tabler.css") continue;
        for (const hit of findFilledIcons(readFileSync(path, "utf8")))
          findings.push({
            file: relative(workspaceRoot, path),
            line: hit.line,
            message: `"${hit.name}" draws nothing: Cloud's icon font has no filled Tabler glyphs; use the outline icon or draw the shape`,
          });
      }
    return findings;
  },
};
