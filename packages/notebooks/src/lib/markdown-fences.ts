export type MarkdownCodeFence = { marker: "`" | "~"; length: number };

/** CommonMark fences allow at most three leading spaces, not code indentation. */
export const openingCodeFence = (line: string): MarkdownCodeFence | null => {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/.exec(line);
  if (!match || (match[1]![0] === "`" && match[2]!.includes("`"))) return null;
  return { marker: match[1]!.startsWith("`") ? "`" : "~", length: match[1]!.length };
};

export const closesCodeFence = (line: string, fence: MarkdownCodeFence): boolean => {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  return !!match && match[1]![0] === fence.marker && match[1]!.length >= fence.length;
};

export const isIndentedCodeLine = (line: string): boolean => /^(?: {4}| {0,3}\t)/.test(line);

/** A notice's closing delimiter cannot be nested deeper than its opener. */
export const closesNotice = (line: string, opener: string): boolean => {
  const closing = /^( {0,3}):::[ \t]*\r?$/.exec(line);
  return !!closing && closing[1]!.length <= (opener.match(/^ */)?.[0].length ?? 0);
};
