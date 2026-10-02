const DEFAULT_PREVIEW_LENGTH = 240;
/** Escaped punctuation waits in the private use area while emphasis is stripped, so an escaped `\*` stays a visible `*`. */
const ESCAPED_BASE = 0xe000;

/** The visible text of a Markdown description on one line, for card and calendar previews; the stored text stays Markdown. */
export const descriptionPreview = (markdown: string | null | undefined, maxLength = DEFAULT_PREVIEW_LENGTH): string | null => {
  if (!markdown?.trim() || maxLength < 1) return null;

  const text = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/```[^\n]*\n?([\s\S]*?)```/g, "$1")
    .replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_, char: string) => String.fromCharCode(ESCAPED_BASE + char.charCodeAt(0)))
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1")
    .replace(/^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:#{1,6}|[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/gm, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1")
    .replace(/[\ue000-\ue07f]/g, (char) => String.fromCharCode(char.charCodeAt(0) - ESCAPED_BASE))
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};
