import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FONT_PRELOAD_LINKS } from "./font-preloads";

const presetPath = fileURLToPath(import.meta.resolve("@k2b/ui/fonts/plex.css"));
const preset = readFileSync(presetPath, "utf8");

test("preloads the Latin IBM Plex Sans faces the preset declares for regular, medium and semibold text", () => {
  const hrefs = [...FONT_PRELOAD_LINKS.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="font\/woff2" crossorigin>/g)].map(
    (match) => match[1]!,
  );
  expect(hrefs).toHaveLength(3);
  const faces = hrefs.map((href) => {
    const file = href.replace("/public/fonts/", "");
    // Core copies the preset's files to /public/fonts under the same names.
    expect(existsSync(resolve(dirname(presetPath), "fonts", file)), file).toBe(true);
    const rule = [...preset.matchAll(/@font-face\{([^}]*)\}/g)].map((match) => match[1]!).find((body) => body.includes(`./fonts/${file})`));
    expect(rule, file).toBeDefined();
    return {
      family: /font-family:([^;]+)/.exec(rule!)?.[1],
      style: /font-style:([^;]+)/.exec(rule!)?.[1],
      weight: /font-weight:([^;]+)/.exec(rule!)?.[1],
      // The Latin subset covers U+0000-00FF (ASCII, German umlauts and ß); minified as `U+??`.
      latin: /unicode-range:U\+(\?\?|0*0-0*ff),/i.test(rule!),
    };
  });
  expect(faces).toEqual(["400", "500", "600"].map((weight) => ({ family: "IBM Plex Sans", style: "normal", weight, latin: true })));
});
