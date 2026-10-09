/**
 * The emoji dataset behind `EmojiPicker` and the composer's `:shortcode` completion. The data (about 80 kB compressed)
 * loads on first use, so a page that never opens either does not download it.
 */

import { isInCodeZone } from "../markdown/code-zone";

/** `0` is the default yellow; `1` (light) to `5` (dark) are the Fitzpatrick modifiers. */
export type EmojiSkinTone = 0 | 1 | 2 | 3 | 4 | 5;

export const EMOJI_SKIN_TONES: readonly EmojiSkinTone[] = [0, 1, 2, 3, 4, 5];

/** The groups in their order. Emojibase numbers them 0 to 9; 2 holds skin-tone parts and never appears. */
export const EMOJI_GROUPS = [
  { id: 0, key: "smileys", icon: "ti ti-mood-smile" },
  { id: 1, key: "people", icon: "ti ti-hand-stop" },
  { id: 3, key: "animals", icon: "ti ti-paw" },
  { id: 4, key: "food", icon: "ti ti-tools-kitchen-2" },
  { id: 5, key: "travel", icon: "ti ti-plane" },
  { id: 6, key: "activities", icon: "ti ti-ball-football" },
  { id: 7, key: "objects", icon: "ti ti-bulb" },
  { id: 8, key: "symbols", icon: "ti ti-heart" },
  { id: 9, key: "flags", icon: "ti ti-flag" },
] as const;

export type EmojiGroupKey = (typeof EMOJI_GROUPS)[number]["key"];

export type EmojiEntry = {
  emoji: string;
  group: number;
  /** The light variant; the other tones swap its modifier. Absent for emoji without skin tones. */
  light?: string;
  name: { en: string; de: string };
  shortcodes: readonly string[];
  /** Normalized names, keywords and shortcodes for search. */
  search: { names: readonly string[]; keywords: readonly string[]; shortcodes: readonly string[]; words: readonly string[] };
};

export type EmojiIndex = {
  entries: readonly EmojiEntry[];
  /** Every emoji and skin-tone variant, without presentation selectors, to its entry. Look up with `findEmoji`. */
  byEmoji: ReadonlyMap<string, EmojiEntry>;
  byShortcode: ReadonlyMap<string, EmojiEntry>;
};

const LIGHT_TONE = "\u{1F3FB}";
const PRESENTATION_SELECTOR = /️/g;

/** Lower case without accents, so "lacheln", "laecheln" and "Lächeln" meet; `_` and `-` separate words. */
export const normalizeEmojiQuery = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ß/g, "ss")
    .replace(/[_\-\s]+/g, " ")
    .trim();

/** German also gets its spelling without umlauts: "Lächeln" is found as "laecheln". */
const germanForms = (value: string): string[] => {
  const plain = normalizeEmojiQuery(value);
  const spelled = normalizeEmojiQuery(value.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue"));
  return spelled === plain ? [plain] : [plain, spelled];
};

const list = (value: string | undefined): string[] => (value ? value.split("|") : []);

export const parseEmojiData = (data: string): EmojiIndex => {
  const entries: EmojiEntry[] = [];
  const byEmoji = new Map<string, EmojiEntry>();
  const byShortcode = new Map<string, EmojiEntry>();
  for (const line of data.split("\n")) {
    const [emoji, group, light, en, enKeywords, de, deKeywords, codes] = line.split("\t");
    if (!emoji || !en || !de) continue;
    const shortcodes = list(codes);
    const names = [normalizeEmojiQuery(en), ...germanForms(de)];
    const keywords = [...list(enKeywords).map(normalizeEmojiQuery), ...list(deKeywords).flatMap(germanForms)];
    const normalizedCodes = shortcodes.map(normalizeEmojiQuery);
    const entry: EmojiEntry = {
      emoji,
      group: Number(group),
      light: light || undefined,
      name: { en, de },
      shortcodes,
      search: {
        names,
        keywords,
        shortcodes: normalizedCodes,
        words: [...new Set([...names, ...keywords, ...normalizedCodes].flatMap((term) => term.split(" ")))],
      },
    };
    entries.push(entry);
    for (const variant of [emoji, ...EMOJI_SKIN_TONES.slice(1).map((tone) => emojiInTone(entry, tone))]) {
      byEmoji.set(variant.replace(PRESENTATION_SELECTOR, ""), entry);
    }
    for (const code of shortcodes) byShortcode.set(code.toLowerCase(), entry);
  }
  return { entries, byEmoji, byShortcode };
};

let loading: Promise<EmojiIndex> | undefined;

/** Loads and indexes the dataset once. A failed load is retried on the next call. */
export const loadEmojiIndex = (): Promise<EmojiIndex> => {
  loading ??= import("./emoji-data").then(
    (module) => parseEmojiData(module.default),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
};

/** The entry of an emoji in any skin tone, with or without presentation selectors. */
export const findEmoji = (index: EmojiIndex, emoji: string): EmojiEntry | undefined =>
  index.byEmoji.get(emoji.replace(PRESENTATION_SELECTOR, ""));

/** The emoji in `tone`; emoji without skin tones stay as they are. */
export const emojiInTone = (entry: EmojiEntry, tone: EmojiSkinTone): string =>
  tone === 0 || !entry.light ? entry.emoji : entry.light.replaceAll(LIGHT_TONE, String.fromCodePoint(0x1f3fb + tone - 1));

/** The name in the render language: German for `de` locales, English otherwise. */
export const emojiName = (entry: EmojiEntry, locale: string): string => (/^de\b/i.test(locale) ? entry.name.de : entry.name.en);

/**
 * Lower is better; `undefined` does not match. A shortcode's prefix beats a name's, so `:tad` finds 🎉 first. `infix`
 * also matches letters inside a name, as the picker's search does.
 */
const rank = (entry: EmojiEntry, query: string, infix: boolean): number | undefined => {
  const { names, keywords, shortcodes, words } = entry.search;
  if (shortcodes.includes(query)) return 0;
  if (names.includes(query)) return 1;
  if (shortcodes.some((code) => code.startsWith(query))) return 2;
  if (names.some((name) => name.startsWith(query))) return 3;
  if (names.some((name) => name.includes(` ${query}`))) return 4;
  if (keywords.includes(query)) return 5;
  if (keywords.some((keyword) => keyword.startsWith(query))) return 6;
  if (infix && names.some((name) => name.includes(query))) return 7;
  // Several words match when each starts a word of the entry: "hand up" finds "raising hand".
  const terms = query.split(" ");
  if (terms.length > 1 && terms.every((term) => words.some((word) => word.startsWith(term)))) return 8;
  return undefined;
};

const ranked = (index: EmojiIndex, query: string, infix: boolean, limit: number): EmojiEntry[] => {
  if (!query) return [];
  const matches: { entry: EmojiEntry; rank: number; position: number }[] = [];
  index.entries.forEach((entry, position) => {
    const value = rank(entry, query, infix);
    if (value !== undefined) matches.push({ entry, rank: value, position });
  });
  matches.sort((left, right) => left.rank - right.rank || left.position - right.position);
  return matches.slice(0, limit).map((match) => match.entry);
};

/** Matches in English and German names, keywords and shortcodes, best first and otherwise in Unicode order. */
export const searchEmoji = (index: EmojiIndex, query: string, limit = Number.POSITIVE_INFINITY): EmojiEntry[] =>
  ranked(index, normalizeEmojiQuery(query.replace(/^:+|:+$/g, "")), true, limit);

/**
 * The suggestions for a `:shortcode` being typed. Only the start of a shortcode, name, word or keyword counts, and a
 * leading sign must start a shortcode, as in `:+1` and `:-1`: emoticons such as `:DD`, `:-D` or `:-P` find nothing,
 * so Enter still sends them.
 */
export const suggestEmoji = (index: EmojiIndex, query: string, limit: number): EmojiEntry[] => {
  if (/^[+-]/.test(query)) {
    const code = query.toLowerCase();
    return index.entries.filter((entry) => entry.shortcodes.some((shortcode) => shortcode.startsWith(code))).slice(0, limit);
  }
  const normalized = normalizeEmojiQuery(query);
  return normalized.length < 2 ? [] : ranked(index, normalized, false, limit);
};

/** As many recent emoji as the picker shows: three rows. */
export const RECENT_EMOJI_LIMIT = 24;

/** The recent list after `emoji` was used: it moves to the front, once, and the oldest drop off. */
export const rememberEmoji = (recent: readonly string[], emoji: string): string[] =>
  [emoji, ...recent.filter((item) => item !== emoji)].slice(0, RECENT_EMOJI_LIMIT);

export type EmojiShortcodeQuery = { start: number; end: number; query: string };

/**
 * The `:shortcode` being typed at the caret: a colon at the start or after a space or "(", then at least two letters,
 * digits, "_", "+" or "-". Code, URLs ("https://") and times ("10:30") are no queries.
 */
export const emojiShortcodeQuery = (text: string, caret: number, selectionEnd = caret): EmojiShortcodeQuery | null => {
  if (caret !== selectionEnd || isInCodeZone(text, caret)) return null;
  const match = /(?:^|[\s(]):([\p{L}\p{N}_+-]{2,})$/u.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, end: caret, query: match[1]! };
};

/** A complete `:shortcode:` just typed at the caret, such as `:thumbsup:`, with its range. */
export const completedEmojiShortcode = (text: string, caret: number): { start: number; end: number; shortcode: string } | null => {
  if (isInCodeZone(text, caret)) return null;
  const match = /(?:^|[\s(]):([\p{L}\p{N}_+-]+):$/u.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1]!.length - 2, end: caret, shortcode: match[1]! };
};
