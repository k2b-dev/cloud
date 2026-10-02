const DEFAULT_PREVIEW_LENGTH = 240;
/** Code contents and escaped characters wait as `\0<index>\0` while the syntax around them is stripped. Stored text
 * cannot hold NUL, and the input loses any NUL first, so a placeholder never collides with the description itself. */
const LITERAL = /\0(\d+)\0/g;
/** A delimiter row (`| --- | :-: |`) marks the line above it as a table header. */
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** The visible text of a Markdown description on one line, for card and calendar previews; the stored text stays Markdown. */
export const descriptionPreview = (markdown: string | null | undefined, maxLength = DEFAULT_PREVIEW_LENGTH): string | null => {
  if (!markdown?.trim() || maxLength < 1) return null;

  const literals: string[] = [];
  const keep = (text: string) => `\0${literals.push(text) - 1}\0`;
  const text = markdown
    .replace(/\0/g, "")
    .replace(/\r\n?/g, "\n")
    // Code shows its contents as written, backslashes included; outside code a backslash only escapes punctuation.
    .replace(/```[^\n]*\n?([\s\S]*?)```|~~~[^\n]*\n?([\s\S]*?)~~~/g, (_, backticks?: string, tildes?: string) =>
      keep(backticks ?? tildes ?? ""),
    )
    .replace(/(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)|\\([!-/:-@[-`{-~])/g, (_, _fence, code?: string, escaped?: string) =>
      keep(code ?? escaped ?? ""),
    )
    .replace(/^([^\n]*\|[^\n]*)\n([^\n]*\|[^\n]*)((?:\n[^\n]*\|[^\n]*)*)/gm, (table: string, _header, delimiter: string) =>
      TABLE_DELIMITER.test(delimiter)
        ? table
            .split("\n")
            .filter((row) => !TABLE_DELIMITER.test(row))
            .map((row) =>
              row
                .replace(/^[ \t]*\|/, "")
                .replace(/\|[ \t]*$/, "")
                .replaceAll("|", " "),
            )
            .join("\n")
        : table,
    )
    .replace(/^[ \t]*(?:=+|(?:[-*_][ \t]*){3,})[ \t]*$/gm, "")
    .replace(/^[ \t]{0,3}\[(?!\^)[^\]\n]+\]:[ \t]*\S.*$/gm, "")
    .replace(/\[\^[^\]\s]+\]:?/g, "")
    .replace(/!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, "$1")
    .replace(/\[([^\]]+)\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\])/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>\s]+|[^\s<>@]+@[^\s<>]+)>/g, "$1")
    .replace(/^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:#{1,6}|[-+*]|\d+[.)])[ \t]+(?:\[[ xX]\](?:[ \t]+|$))?)?/gm, "")
    .replace(/<!--[\s\S]*?-->|<\/?[A-Za-z][\w-]*(?:\s[^<>\n]*)?\/?>/g, " ")
    // Emphasis needs text right inside its markers, so `3 * 4` and `a < b` stay as written.
    .replace(/\*\*(?![\s*])([^*]*?[^\s*])\*\*/g, "$1")
    .replace(/(?<!\w)__(?![\s_])([^_]*?[^\s_])__(?!\w)/g, "$1")
    .replace(/~~(?![\s~])([^~]*?[^\s~])~~/g, "$1")
    .replace(/(?<!\*)\*(?![\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1")
    .replace(/(?<!\w)_(?![\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1")
    .replace(LITERAL, (_, index: string) => literals[Number(index)]!)
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return null;
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};
