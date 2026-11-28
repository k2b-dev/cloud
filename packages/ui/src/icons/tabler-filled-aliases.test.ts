import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Records may hold a filled name Cloud's icon catalog once offered (`ti ti-star-filled`). The preset has no filled
// font (#4558), so its stylesheet gives such a name the glyph of its outline twin: the same codepoint as Tabler's
// `ti-star`. A name without that twin, or a codepoint that drifts from Tabler's, fails here.
const preset = readFileSync(resolve(import.meta.dir, "tabler.css"), "utf8");
const tabler = readFileSync(fileURLToPath(import.meta.resolve("@tabler/icons-webfont/dist/tabler-icons.min.css")), "utf8");

const aliases = [...preset.matchAll(/\.ti-([a-z0-9-]+)-filled::before\s*\{\s*content:\s*"([^"]+)";\s*\}/g)].map(([, outline, content]) => ({
  outline: outline!,
  content: content!,
}));
const outlineContent = (name: string) => new RegExp(`\\.ti-${name}:before\\{content:"([^"]+)"\\}`).exec(tabler)?.[1];

test("the filled names of the old icon catalog draw their outline glyph", () => {
  expect(aliases.map((alias) => alias.outline)).toEqual(["star", "heart"]);
  for (const alias of aliases) expect(alias.content).toBe(outlineContent(alias.outline)!);
});
