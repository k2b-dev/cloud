/** Shells and double-escaped JSON can turn a line break into the two characters `\n`. */
export const hasEscapedLineBreak = (text: string): boolean => {
  if (/[\r\n]/.test(text)) return false;
  const prose = text.replace(/(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/g, " ");
  return /(?:^|[^\\])(?:\\\\)*\\n/.test(prose);
};
