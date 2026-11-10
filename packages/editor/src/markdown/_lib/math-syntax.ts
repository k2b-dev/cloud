/** KaTeX source syntax, shared by the math widgets and every decoration that must leave math alone. */
// Delimiters cannot nest. Stop at a new opening delimiter so malformed pasted
// brackets cannot consume a later formula or repeatedly scan the document tail.
export const blockMathPattern = (): RegExp => /\$\$([^$]+)\$\$|\\\[((?:(?!\\\[).)*?)\\\]/gs;
export const inlineMathPattern = (): RegExp => /(?<!\$)\$(?!\$)([^\n$]+)\$(?!\$)|\\\(((?:(?!\\\()[^)\n])*?)\\\)/g;
export const hasMathMarker = (text: string): boolean => /\$|\\[()[\]]/.test(text);
