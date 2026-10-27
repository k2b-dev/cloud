const QUOTED_LINE = /^\s*>/u;
/** Separators that clients put above forwarded or quoted originals instead of `>` prefixes. */
const HISTORY_SEPARATOR =
  /^\s*(?:-{2,}\s*(?:original message|ursprüngliche nachricht|forwarded message|weitergeleitete nachricht)\s*-*|_{10,})\s*$/iu;
/** A horizontal rule, which HTML clients such as Outlook put above their header block. */
const RULE_LINE = /^\s*[-_=]{10,}\s*$/u;
/** Header lines that clients copy above a quoted or forwarded original, in English and German. */
const HEADER_LINE = /^\s*\*?(?:from|von|sent|gesendet|date|datum|to|an|cc|bcc|subject|betreff|reply-to|antwort an)\s*:/iu;
const FROM_HEADER = /^\s*\*?(?:from|von)\s*:\*?\s*\S/iu;
const DATE_HEADER = /^\s*\*?(?:sent|gesendet|date|datum)\s*:/iu;
/** "On … wrote:" and its translations, which may wrap over a few lines above a quote. */
const ATTRIBUTION = /\b(?:wrote|schrieb|écrit|escribió|scrisse|schreef|skrev)\b|@/iu;

const isBlank = (line: string | undefined) => !line?.trim();

/** An Outlook-style block such as "From: …" followed by "Sent: …" within the next lines. */
const startsHeaderBlock = (lines: string[], index: number) =>
  FROM_HEADER.test(lines[index] ?? "") && lines.slice(index + 1, index + 4).some((line) => DATE_HEADER.test(line));

/**
 * Removes `>` quoted lines and the attribution paragraph right above each
 * quoted block, but keeps the unquoted lines between and after them, so
 * bottom-posted and inline replies keep their own text.
 */
const dropQuotedLines = (lines: string[]): string[] => {
  const kept: string[] = [];
  let quoting = false;
  for (const line of lines) {
    if (QUOTED_LINE.test(line)) {
      if (!quoting) {
        while (kept.length > 0 && isBlank(kept.at(-1))) kept.pop();
        const paragraphStart = kept.findLastIndex((candidate) => isBlank(candidate)) + 1;
        const paragraph = kept.slice(paragraphStart);
        if (paragraph.length <= 3 && paragraph.at(-1)?.trimEnd().endsWith(":") && ATTRIBUTION.test(paragraph.join(" "))) {
          kept.length = paragraphStart;
        }
      }
      quoting = true;
      continue;
    }
    if (quoting && kept.length > 0) kept.push("");
    quoting = false;
    kept.push(line);
  }
  return kept;
};

/** Skips a separator and the header block above a forwarded or quoted original. */
const skipHeaderBlock = (lines: string[]): string[] => {
  let index = HISTORY_SEPARATOR.test(lines[0] ?? "") || RULE_LINE.test(lines[0] ?? "") ? 1 : 0;
  while (index < lines.length && isBlank(lines[index])) index += 1;
  const headerStart = index;
  // Header values may wrap onto indented continuation lines.
  while (index < lines.length && (HEADER_LINE.test(lines[index]!) || (index > headerStart && /^\s+\S/u.test(lines[index]!)))) index += 1;
  return lines.slice(index);
};

/**
 * The message's own text without quoted history. Everything from the first
 * forward or original-message separator, or Outlook-style header block, is
 * history; `>` quoted lines are removed wherever they appear. A forward
 * without text of its own shows the forwarded message instead, unless
 * forwardedFallback is false (workflow metrics count only the reply).
 */
export const stripQuotedHistory = (text: string, forwardedFallback = true): string => {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const start = lines.findIndex((line, index) => HISTORY_SEPARATOR.test(line) || startsHeaderBlock(lines, index));
  const own = dropQuotedLines(start < 0 ? lines : lines.slice(0, start));
  while (own.length > 0 && (isBlank(own.at(-1)) || RULE_LINE.test(own.at(-1)!))) own.pop();
  if (!forwardedFallback || start < 0 || own.some((line) => !isBlank(line))) return own.join("\n");
  return dropQuotedLines(skipHeaderBlock(lines.slice(start))).join("\n");
};

/** Unicode code points in trimmed plain reply text; only RFC-style "-- " signatures are recognized. */
export const mailMessageTextLength = (plainText: string): number => {
  const own = stripQuotedHistory(plainText, false);
  const lines = own.split("\n");
  const signature = lines.findIndex((line) => line === "-- ");
  const text = (signature < 0 ? own : lines.slice(0, signature).join("\n")).trim();
  let length = 0;
  for (const _character of text) length += 1;
  return length;
};
