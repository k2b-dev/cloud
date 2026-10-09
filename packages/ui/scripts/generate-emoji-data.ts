/**
 * Writes the emoji dataset of `EmojiPicker` from `emojibase-data` (MIT): English and German names and keywords, GitHub
 * shortcodes, groups, and the skin-tone variants. Run it after updating `emojibase-data`.
 */
import { resolve } from "node:path";

if (process.argv.includes("--help")) {
  console.log(`Usage: bun packages/ui/scripts/generate-emoji-data.ts [--check]

Writes packages/ui/src/inputs/emoji/emoji-data.ts from emojibase-data.
  --check  fail when the committed file differs from the generated one`);
  process.exit(0);
}

type SourceEmoji = {
  hexcode: string;
  emoji: string;
  label: string;
  tags?: string[];
  group?: number;
  order?: number;
  version: number;
  /** 1 when the emoji shows as emoji by default, 0 when it needs the emoji presentation selector. */
  type: number;
  tone?: number | number[];
  skins?: SourceEmoji[];
};

/**
 * Newer emoji show as empty boxes on many systems. Emoji 15.1 (2023) renders on current Apple, Android, Windows 11,
 * and Noto systems; raise it together with an emojibase update once the next version is as widespread.
 */
const MAX_VERSION = 15.1;
/** Emojibase's "component" group holds skin tones and hair parts, which are no emoji of their own. */
const COMPONENT_GROUP = 2;
const LIGHT_TONE = "\u{1F3FB}";

const root = resolve(import.meta.dir, "..");
const source = resolve(root, "node_modules/emojibase-data");
const destination = resolve(root, "src/inputs/emoji/emoji-data.ts");

const read = async <T>(path: string): Promise<T> => (await Bun.file(resolve(source, path)).json()) as T;
const { version } = await read<{ version: string }>("package.json");
const english = await read<SourceEmoji[]>("en/data.json");
const german = new Map((await read<SourceEmoji[]>("de/data.json")).map((entry) => [entry.hexcode, entry]));
const shortcodes = await read<Record<string, string | string[]>>("en/shortcodes/github.json");

/**
 * The fully qualified form, as people's keyboards send it. Emojibase appends the presentation selector to every single
 * code point, also where the code point shows as emoji anyway, so "👍" and "👍️" would count as two reactions.
 */
const qualified = (entry: SourceEmoji): string => {
  const codes = entry.hexcode.split("-").map((code) => Number.parseInt(code, 16));
  if (codes.length === 1 && entry.type === 0) codes.push(0xfe0f);
  return String.fromCodePoint(...codes);
};

/** One field may not contain the separators of the format, nor what a template literal would read. */
const field = (value: string): string => {
  if (/[\t\n|`\\]|\$\{/.test(value)) throw new Error(`Unexpected character in emoji data: ${JSON.stringify(value)}`);
  return value;
};
const keywords = (label: string, tags: readonly string[] | undefined): string =>
  [...new Set(tags ?? [])]
    .filter((tag) => tag.toLowerCase() !== label.toLowerCase())
    .map(field)
    .join("|");

/** Only the light variant is stored; every single-tone variant swaps that one modifier for its own. */
const lightVariant = (entry: SourceEmoji): string => {
  const singles = (entry.skins ?? []).filter((skin) => typeof skin.tone === "number" && skin.version <= MAX_VERSION);
  if (singles.length !== 5) return "";
  const light = singles.find((skin) => skin.tone === 1)!.emoji;
  for (const skin of singles) {
    const expected = light.replaceAll(LIGHT_TONE, String.fromCodePoint(0x1f3fb + (skin.tone as number) - 1));
    if (skin.emoji !== expected) throw new Error(`Skin tone variant of ${entry.label} does not follow the modifier rule`);
  }
  return light;
};

const lines = english
  .filter((entry) => entry.group !== undefined && entry.group !== COMPONENT_GROUP && entry.version <= MAX_VERSION)
  .sort((left, right) => (left.order ?? 0) - (right.order ?? 0))
  .map((entry) => {
    const translated = german.get(entry.hexcode);
    if (!translated) throw new Error(`No German name for ${entry.label}`);
    const codes = shortcodes[entry.hexcode];
    return [
      field(qualified(entry)),
      String(entry.group),
      lightVariant(entry),
      field(entry.label),
      keywords(entry.label, entry.tags),
      field(translated.label),
      keywords(translated.label, translated.tags),
      (Array.isArray(codes) ? codes : codes ? [codes] : []).map(field).join("|"),
    ].join("\t");
  });

const output = `// Generated from emojibase-data ${version} (MIT, https://emojibase.dev). Do not edit here.
// Regenerate: bun packages/ui/scripts/generate-emoji-data.ts
// One emoji per line: emoji, group, light skin-tone variant, English name, English keywords, German name,
// German keywords, GitHub shortcodes. Tabs separate the fields, "|" the entries of a list.
export default \`${lines.join("\n")}\`;
`;

if (process.argv.includes("--check")) {
  const current = await Bun.file(destination)
    .text()
    .catch(() => "");
  if (current !== output) throw new Error("The emoji data is stale. Run bun packages/ui/scripts/generate-emoji-data.ts");
} else {
  await Bun.write(destination, output);
  console.log(`Wrote ${lines.length} emoji to ${destination}`);
}
