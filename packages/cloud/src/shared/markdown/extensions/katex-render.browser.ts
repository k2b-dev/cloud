import type Katex from "katex";
import { createSignal } from "solid-js";

let katex: typeof Katex | undefined;
let loading = false;
const [loaded, setLoaded] = createSignal(false);

/**
 * LaTeX as KaTeX HTML in the browser, where KaTeX loads only once content needs it. Until it is there this returns
 * `null`; a reactive render that met math reads `loaded` and runs again once KaTeX arrived. A failed load is tried
 * again by the next render that needs it.
 */
export const renderLatex = (latex: string, displayMode: boolean): string | null => {
  if (katex) return katex.renderToString(latex, { throwOnError: false, displayMode });
  loaded();
  if (!loading) {
    loading = true;
    void import("katex").then(
      (module) => {
        katex = module.default;
        setLoaded(true);
      },
      () => {
        loading = false;
      },
    );
  }
  return null;
};
