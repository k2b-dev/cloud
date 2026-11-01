/** KaTeX source syntax, shared by the math widgets and every decoration that must leave math alone. */
export const blockMathPattern = (): RegExp => /\$\$([^$]+)\$\$|\\\[(.*?)\\\]/gs;
export const inlineMathPattern = (): RegExp => /(?<!\$)\$(?!\$)([^\n$]+)\$(?!\$)|\\\(([^)\n]*?)\\\)/g;
