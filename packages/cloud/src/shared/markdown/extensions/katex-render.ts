import katex from "katex";

/** LaTeX as KaTeX HTML. The server and every non-browser runtime have KaTeX at hand, so this never waits. */
export const renderLatex = (latex: string, displayMode: boolean): string | null =>
  katex.renderToString(latex, { throwOnError: false, displayMode });
