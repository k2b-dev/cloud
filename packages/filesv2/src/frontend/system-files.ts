/*
 * Browsers do not expose the operating system's hidden attribute, so folder uploads recognize system files by the
 * well-known names macOS, Windows and Linux desktops write into folders. Ordinary dotfiles such as `.gitignore` or
 * `.env` are user content and never match. Windows names are case-insensitive, so every comparison is.
 */
const NAMES = new Set(
  [
    // macOS
    ".DS_Store",
    ".Spotlight-V100",
    ".Trashes",
    ".fseventsd",
    ".TemporaryItems",
    ".DocumentRevisions-V100",
    "Icon\r",
    // Windows
    "Thumbs.db",
    "ehthumbs.db",
    "desktop.ini",
    "$RECYCLE.BIN",
    "System Volume Information",
    // Linux desktops
    ".directory",
  ].map((name) => name.toLowerCase()),
);
// macOS AppleDouble companions (`._name`) and per-user trash folders on Linux volumes (`.Trash-1000`).
const PREFIXES = ["._", ".trash-"];

export const isSystemFileName = (name: string) => {
  const lower = name.toLowerCase();
  return NAMES.has(lower) || PREFIXES.some((prefix) => lower.startsWith(prefix) && lower.length > prefix.length);
};

/**
 * The outermost system entry on a relative upload path, or null. The first segment is what the person picked or
 * dragged, so it always counts as content; only entries inside an uploaded folder are checked.
 */
export const systemEntry = (path: string): string | null => {
  const parts = path.split("/");
  const index = parts.findIndex((part, position) => position > 0 && isSystemFileName(part));
  return index < 0 ? null : parts.slice(0, index + 1).join("/");
};

/** A system name as people recognize it; the macOS custom-icon file ends in a carriage return. */
export const systemEntryLabel = (entry: string) => entry.split("/").at(-1)!.replace(/\r/g, "");
