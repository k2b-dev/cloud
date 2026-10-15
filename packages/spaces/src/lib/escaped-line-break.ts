/** Backslash escapes, code spans, and unmatched backtick runs, read left to right like Markdown does. */
const MARKDOWN_TOKENS = /\\[\s\S]|(`+)(?!`)[\s\S]+?(?<!`)\1(?!`)|`+/g;

/** Shells and double-escaped JSON can turn a line break into the two characters `\n`. */
export const hasEscapedLineBreak = (text: string): boolean =>
  !/[\r\n]/.test(text) && Array.from(text.matchAll(MARKDOWN_TOKENS), ([token]) => token).includes("\\n");
