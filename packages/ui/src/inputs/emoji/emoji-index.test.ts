import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { nextEmojiIndex } from "./EmojiPicker";
import {
  completedEmojiShortcode,
  emojiInTone,
  emojiName,
  emojiShortcodeQuery,
  findEmoji,
  loadEmojiIndex,
  RECENT_EMOJI_LIMIT,
  rememberEmoji,
  searchEmoji,
} from "./emoji-index";

const index = await loadEmojiIndex();
const top = (query: string, count = 3) =>
  searchEmoji(index, query, count)
    .map((entry) => entry.emoji)
    .join(" ");

describe("emoji data", () => {
  // A second process reads emojibase-data; it takes a tenth of a second, but more on a busy machine.
  test("matches what the generator writes from emojibase-data", async () => {
    const generator = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../../scripts/generate-emoji-data.ts"), "--check"], {
      stderr: "pipe",
    });
    const error = await new Response(generator.stderr).text();
    expect(await generator.exited, error).toBe(0);
  }, 30_000);

  test("holds every group in Unicode order, in the form keyboards send", () => {
    expect(index.entries.length).toBeGreaterThan(1800);
    expect(index.entries[0]!.emoji).toBe("😀");
    // Emoji that show as emoji anyway carry no presentation selector; text-default ones do.
    expect(index.byShortcode.get("+1")!.emoji).toBe("\u{1F44D}");
    expect(index.byShortcode.get("heart")!.emoji).toBe("❤️");
    expect(new Set(index.entries.map((entry) => entry.group))).toEqual(new Set([0, 1, 3, 4, 5, 6, 7, 8, 9]));
  });
});

describe("searchEmoji", () => {
  test("finds German and English names, keywords and shortcodes", () => {
    expect(top("Daumen", 1)).toBe("👍");
    expect(top("thumbs up", 1)).toBe("👍");
    expect(top(":+1:", 1)).toBe("👍");
    expect(top("kaffee", 1)).toBe("☕");
    expect(top("coffee", 1)).toBe("☕");
    expect(top("deutschland", 1)).toBe("🇩🇪");
    expect(top("joy", 1)).toBe("😂");
    // A shortcode's prefix comes before a name's: "tad" is :tada:, not "Tadschikistan".
    expect(top("tad", 1)).toBe("🎉");
    expect(top("thumbs", 2)).toBe("👍 👎");
  });

  test("ignores case, accents and umlaut spelling", () => {
    expect(top("LÄCHELN")).toBe(top("lacheln"));
    expect(top("laecheln")).toBe(top("lächeln"));
    expect(top("party_popper", 1)).toBe("🎉");
  });

  test("requires every word of a longer query", () => {
    expect(searchEmoji(index, "raising hands").map((entry) => entry.emoji)).toContain("🙌");
    expect(searchEmoji(index, "xyzzy nothing")).toEqual([]);
    expect(searchEmoji(index, "   ")).toEqual([]);
  });

  test("names an emoji in the render language", () => {
    const thumbs = index.byShortcode.get("thumbsup")!;
    expect(emojiName(thumbs, "de-AT")).toBe("Daumen hoch");
    expect(emojiName(thumbs, "en")).toBe("thumbs up");
    expect(emojiName(thumbs, "fr")).toBe("thumbs up");
  });
});

describe("skin tones", () => {
  test("apply to emoji that have them and leave the others", () => {
    const thumbs = index.byShortcode.get("thumbsup")!;
    expect([0, 1, 2, 3, 4, 5].map((tone) => emojiInTone(thumbs, tone as 0)).join(" ")).toBe("👍 👍🏻 👍🏼 👍🏽 👍🏾 👍🏿");
    const couple = searchEmoji(index, "people holding hands", 1)[0]!;
    expect(emojiInTone(couple, 5)).toBe("🧑🏿‍🤝‍🧑🏿");
    expect(emojiInTone(index.byShortcode.get("coffee")!, 3)).toBe("☕");
  });

  test("lead back to the emoji, with or without the presentation selector", () => {
    expect(findEmoji(index, "\u{1F44D}\u{1F3FD}")?.shortcodes).toContain("+1");
    expect(findEmoji(index, "\u{1F44D}\uFE0F")?.shortcodes).toContain("+1");
    expect(findEmoji(index, "\u2764")?.shortcodes).toContain("heart");
    expect(findEmoji(index, "\u2764\uFE0F")?.shortcodes).toContain("heart");
  });
});

describe("rememberEmoji", () => {
  test("puts the emoji first, once, and keeps three rows", () => {
    expect(rememberEmoji(["😀", "👍", "🎉"], "👍")).toEqual(["👍", "😀", "🎉"]);
    const full = Array.from({ length: RECENT_EMOJI_LIMIT }, (_, position) => String(position));
    expect(rememberEmoji(full, "new")).toEqual(["new", ...full.slice(0, RECENT_EMOJI_LIMIT - 1)]);
  });
});

describe("shortcodes in text", () => {
  test("find the shortcode being typed, but not times, URLs or code", () => {
    const at = (text: string) => emojiShortcodeQuery(text, text.length);
    expect(at("Great :thu")).toEqual({ start: 6, end: 10, query: "thu" });
    expect(at(":+1")).toEqual({ start: 0, end: 3, query: "+1" });
    expect(at("(:sm")?.query).toBe("sm");
    expect(at("Great :t")).toBeNull();
    expect(at("at 10:30")).toBeNull();
    expect(at("see https://example")).toBeNull();
    expect(at("`code :thu")).toBeNull();
    expect(at("Great :thumbsup ")).toBeNull();
    expect(emojiShortcodeQuery("Great :thu", 8, 10)).toBeNull();
  });

  test("find a completed shortcode before the caret", () => {
    expect(completedEmojiShortcode("Great :thumbsup:", 16)).toEqual({ start: 6, end: 16, shortcode: "thumbsup" });
    expect(completedEmojiShortcode("12:30:", 6)).toBeNull();
    expect(completedEmojiShortcode("`x :tada:", 9)).toBeNull();
  });
});

describe("nextEmojiIndex", () => {
  // Two groups: 10 emoji (rows of 8 and 2) and 5 emoji.
  const sizes = [10, 5];
  test("moves by one to the side and by rows of eight up and down", () => {
    expect(nextEmojiIndex(sizes, 3, "ArrowRight")).toBe(4);
    expect(nextEmojiIndex(sizes, 0, "ArrowLeft")).toBe(0);
    expect(nextEmojiIndex(sizes, 14, "ArrowRight")).toBe(14);
    expect(nextEmojiIndex(sizes, 1, "ArrowDown")).toBe(9);
    expect(nextEmojiIndex(sizes, 9, "ArrowUp")).toBe(1);
  });

  test("goes to the last emoji of a shorter row and across groups in the same column", () => {
    expect(nextEmojiIndex(sizes, 5, "ArrowDown")).toBe(9);
    expect(nextEmojiIndex(sizes, 9, "ArrowDown")).toBe(11);
    expect(nextEmojiIndex(sizes, 7, "ArrowDown")).toBe(9);
    expect(nextEmojiIndex(sizes, 14, "ArrowUp")).toBe(9);
    expect(nextEmojiIndex(sizes, 10, "ArrowUp")).toBe(8);
    expect(nextEmojiIndex(sizes, 2, "ArrowUp")).toBe(2);
    expect(nextEmojiIndex(sizes, 14, "ArrowDown")).toBe(14);
  });

  test("skips empty groups and starts at the first emoji", () => {
    expect(nextEmojiIndex([3, 0, 4], 1, "ArrowDown")).toBe(4);
    expect(nextEmojiIndex([3, 0, 4], 4, "ArrowUp")).toBe(1);
    expect(nextEmojiIndex([0], 0, "ArrowDown")).toBe(-1);
    expect(nextEmojiIndex([4], -1, "ArrowDown")).toBe(0);
  });
});
