import type Katex from "katex";
import { createSignal } from "solid-js";
import { importOnDemand } from "../../../browser/reload";

let katex: typeof Katex | undefined;
let loading = false;
const [loaded, setLoaded] = createSignal(false);

/**
 * LaTeX as KaTeX HTML in the browser, where KaTeX loads only once content needs it. Until it is there this returns
 * `null`; a reactive render that met math reads `loaded` and runs again once KaTeX arrived. A load that fails, after
 * a release or with the connection gone, offers a reload as every on-demand code does; the formulas keep their
 * source, and the next render that needs KaTeX tries again.
 */
export const renderLatex = (latex: string, displayMode: boolean): string | null => {
  if (katex) return katex.renderToString(latex, { throwOnError: false, displayMode });
  loaded();
  if (!loading) {
    loading = true;
    void importOnDemand(() => import("katex")).then((module) => {
      if (!module) {
        loading = false;
        return;
      }
      katex = module.default;
      setLoaded(true);
    });
  }
  return null;
};
