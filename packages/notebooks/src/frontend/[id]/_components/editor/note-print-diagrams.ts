export type PrintDiagramRenderer = (source: string, signal: AbortSignal) => Promise<string>;

// A disposed note's unabortable Mermaid call may still be finishing when the next note mounts.
let pending: Promise<void> = Promise.resolve();
function renderSerial(renderer: PrintDiagramRenderer, source: string, signal: AbortSignal) {
  const result = pending.then(() => {
    signal.throwIfAborted();
    return renderer(source, signal);
  });
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
}

/** One serial worker; new content invalidates late results and reuses only current sources. */
export function createPrintDiagrams(root: HTMLElement, load: () => Promise<PrintDiagramRenderer>) {
  const cache = new Map<string, string>();
  let revision = 0;
  let controller = new AbortController();
  let running = false;
  let disposed = false;
  let renderer: PrintDiagramRenderer | undefined;
  const figures = () => Array.from(root.querySelectorAll<HTMLElement>("figure.notebook-book-mermaid"));
  const source = (figure: HTMLElement) => figure.querySelector("code.language-mermaid")?.textContent;
  const replace = (figure: HTMLElement, svg: string) => {
    const image = document.createElement("img");
    image.className = "notebook-book-diagram";
    image.alt = figure.querySelector("figcaption")?.textContent ?? "";
    // An image URL never exposes Mermaid's returned SVG as executable document DOM.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    image.loading = "eager";
    figure.replaceChildren(image);
  };
  const pump = async () => {
    if (running || disposed || !figures().some((figure) => source(figure) !== undefined)) return;
    running = true;
    try {
      renderer ??= await load();
      while (!disposed) {
        const version = revision;
        const signal = controller.signal;
        for (const figure of figures()) {
          if (disposed || version !== revision) break;
          const text = source(figure);
          if (text === undefined) continue;
          try {
            const svg = cache.get(text) ?? (await renderSerial(renderer, text, signal));
            if (disposed || version !== revision) break;
            cache.set(text, svg);
            replace(figure, svg);
          } catch {
            // The complete, readable source remains printable if Mermaid rejects it.
          }
        }
        if (version === revision) break;
      }
    } catch (error) {
      console.warn("Note print diagrams unavailable; printing their source.", error);
    } finally {
      running = false;
    }
  };
  return {
    refresh() {
      revision++;
      controller.abort();
      controller = new AbortController();
      const current = figures();
      const sources = new Set(current.map(source));
      for (const key of cache.keys()) if (!sources.has(key)) cache.delete(key);
      // Cached diagrams must be ready during the synchronous beforeprint render.
      for (const figure of current) {
        const text = source(figure);
        const svg = text === undefined ? undefined : cache.get(text);
        if (svg !== undefined) replace(figure, svg);
      }
      void pump();
    },
    dispose() {
      disposed = true;
      controller.abort();
      revision++;
      cache.clear();
    },
  };
}
