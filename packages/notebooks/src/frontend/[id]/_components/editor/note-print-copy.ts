import type { renderNotebookBook } from "../../../../lib/book-renderer";
import { renderMermaid } from "../../../lib/mermaid-render";
import { createPrintDiagrams, mermaidFenceSources } from "./note-print-diagrams";

type Options = {
  notebookId: string;
  noteId: string;
  markdown: () => string;
  locale: () => string;
};

async function loadDiagrams() {
  const [{ default: mermaid }, { mermaidConfig }] = await Promise.all([import("mermaid"), import("@k2b/cloud/browser/mermaid")]);
  return async (source: string, signal: AbortSignal) => {
    const scratch = document.createElement("div");
    scratch.style.cssText = "position:absolute;left:-100000px";
    scratch.setAttribute("aria-hidden", "true");
    document.body.append(scratch);
    const remove = () => scratch.remove();
    signal.addEventListener("abort", remove, { once: true });
    try {
      return (
        await renderMermaid(
          mermaid,
          { ...mermaidConfig({ dark: false }), htmlLabels: false },
          `note-print-${crypto.randomUUID()}`,
          source,
          scratch,
        )
      ).svg;
    } finally {
      signal.removeEventListener("abort", remove);
      remove();
    }
  };
}

/** A complete Book copy, independent of the editor's virtualized viewport. Mount per note. */
export function createNotePrintCopy(article: HTMLElement, options: Options) {
  let renderBook: typeof renderNotebookBook | undefined;
  let last: { markdown: string; locale: string } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelIdle: (() => void) | undefined;
  let disposed = false;
  const diagrams = createPrintDiagrams(article, loadDiagrams);
  const media = window.matchMedia("print");
  const eagerImages = () =>
    article.querySelectorAll("img").forEach((image) => {
      image.loading = "eager";
    });
  const render = () => {
    if (disposed || !renderBook) return;
    const markdown = options.markdown();
    const locale = options.locale();
    if (last?.markdown === markdown && last.locale === locale) return;
    try {
      const { html } = renderBook({ markdown, locale, notebookId: options.notebookId, noteId: options.noteId, querySource: true });
      article.innerHTML = html;
      article.setAttribute("data-print-region", "");
      last = { markdown, locale };
      diagrams.refresh();
      if (media.matches) eagerImages();
    } catch (error) {
      article.removeAttribute("data-print-region");
      article.replaceChildren();
      last = undefined;
      console.warn("Note print copy unavailable; showing the app's print hint.", error);
    }
  };
  const load = async () => {
    try {
      const module = await import("../../../../lib/book-renderer");
      if (disposed) return;
      renderBook = module.renderNotebookBook;
      // Print media can become active before the idle import completes.
      if (media.matches) render();
    } catch (error) {
      console.warn("Note print renderer unavailable; showing the app's print hint.", error);
    }
  };
  const idle = (work: () => void) => {
    const run = () => {
      if (!disposed) work();
    };
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(run);
      return () => window.cancelIdleCallback(id);
    }
    const id = setTimeout(run, 0);
    return () => clearTimeout(id);
  };
  const warm = () => diagrams.warm(mermaidFenceSources(options.markdown()));
  const print = () => {
    // Synchronous once the idle import completed. An earlier print uses Layout's fallback.
    render();
    eagerImages();
  };
  const onMedia = (event: MediaQueryListEvent) => {
    if (event.matches) print();
  };
  window.addEventListener("beforeprint", print);
  media.addEventListener("change", onMedia);
  const cancelMountIdle = idle(() => {
    void load();
    warm();
  });
  return {
    changed() {
      if (disposed) return;
      clearTimeout(timer);
      cancelIdle?.();
      cancelIdle = undefined;
      timer = setTimeout(() => {
        cancelIdle = idle(() => {
          cancelIdle = undefined;
          warm();
        });
      }, 2000);
    },
    dispose() {
      disposed = true;
      cancelMountIdle();
      clearTimeout(timer);
      cancelIdle?.();
      diagrams.dispose();
      window.removeEventListener("beforeprint", print);
      media.removeEventListener("change", onMedia);
      article.removeAttribute("data-print-region");
      article.replaceChildren();
    },
  };
}
