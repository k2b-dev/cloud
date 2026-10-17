import { rememberEmoji } from "@k2b/ui";

/** Stored per browser, never on the server. */
export const RECENT_EMOJI_KEY = "spaces:recent-emoji";
/** One picker row of eight, shown until the person has used an emoji. */
export const DEFAULT_RECENT_EMOJI: readonly string[] = ["👍", "❤️", "🎉", "😄", "👀", "🚀", "✅", "🙏"];

const storage = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    // Private modes and blocked storage throw on access.
    return undefined;
  }
};

/** The recent emoji, most recent first; the default set while nothing valid is stored. */
export const readRecentEmoji = (): string[] => {
  try {
    const stored: unknown = JSON.parse(storage()?.getItem(RECENT_EMOJI_KEY) ?? "null");
    if (Array.isArray(stored)) {
      // The picker shows only its own number of recent emoji, and every write goes through the bounded rememberEmoji.
      const recent = stored.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
      if (recent.length) return recent;
    }
  } catch {
    // A damaged value falls back to the default set.
  }
  return [...DEFAULT_RECENT_EMOJI];
};

/** Moves `emoji` to the front and stores the list; storage that refuses the write keeps the list for this page only. */
export const rememberRecentEmoji = (emoji: string): string[] => {
  const next = rememberEmoji(readRecentEmoji(), emoji);
  try {
    storage()?.setItem(RECENT_EMOJI_KEY, JSON.stringify(next));
  } catch {
    // Full or blocked storage: the pick still counts.
  }
  return next;
};
