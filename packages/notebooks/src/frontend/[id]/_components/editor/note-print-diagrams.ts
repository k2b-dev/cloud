import { closesCodeFence, type MarkdownCodeFence, openingCodeFence } from "../../../../lib/markdown-fences";

/** Container-prefixed fences in lists or blockquotes print as readable source on first print. */
export function mermaidFenceSources(markdown: string): string[] {
  const sources: string[] = [];
  let fence: MarkdownCodeFence | null = null;
  let indent = 0;
  let content: string[] | undefined;
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (!fence) {
      fence = openingCodeFence(line);
      if (!fence) continue;
      indent = line.length - line.trimStart().length;
      const language = line
        .slice(indent + fence.length)
        .trim()
        .split(/\s+/)[0]
        ?.toLowerCase();
      content = language === "mermaid" ? [] : undefined;
    } else if (closesCodeFence(line, fence)) {
      if (content) sources.push(content.join("\n"));
      fence = null;
      content = undefined;
    } else if (content) {
      let spaces = 0;
      while (spaces < indent && line[spaces] === " ") spaces++;
      content.push(line.slice(spaces));
    }
  }
  if (content) sources.push(content.join("\n"));
  return sources;
}

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
  const installed = new WeakMap<HTMLElement, string>();
  let wanted = new Set<string>();
  let revision = 0;
  let controller = new AbortController();
  let running = false;
  let disposed = false;
  let renderer: PrintDiagramRenderer | undefined;
  const figures = () => Array.from(root.querySelectorAll<HTMLElement>("figure.notebook-book-mermaid"));
  const source = (figure: HTMLElement) => figure.querySelector("code.language-mermaid")?.textContent ?? installed.get(figure);
  const sources = () => {
    const current = new Set(wanted);
    for (const figure of figures()) {
      const text = source(figure);
      if (text !== undefined) current.add(text);
    }
    return current;
  };
  const replace = (figure: HTMLElement, text: string, svg: string) => {
    if (!figure.querySelector("code.language-mermaid")) return;
    installed.set(figure, text);
    const image = document.createElement("img");
    image.className = "notebook-book-diagram";
    image.alt = figure.querySelector("figcaption")?.textContent ?? "";
    // An image URL never exposes Mermaid's returned SVG as executable document DOM.
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    image.loading = "eager";
    figure.replaceChildren(image);
  };
  const pump = async () => {
    if (running || disposed || !Array.from(sources()).some((text) => !cache.has(text))) return;
    running = true;
    try {
      renderer ??= await load();
      while (!disposed) {
        const version = revision;
        const signal = controller.signal;
        for (const text of sources()) {
          if (disposed || version !== revision) break;
          if (cache.has(text)) continue;
          try {
            const svg = await renderSerial(renderer, text, signal);
            if (disposed || version !== revision) break;
            cache.set(text, svg);
            for (const figure of figures()) if (source(figure) === text) replace(figure, text, svg);
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
  const refresh = () => {
    if (disposed) return;
    revision++;
    controller.abort();
    controller = new AbortController();
    const current = sources();
    for (const key of cache.keys()) if (!current.has(key)) cache.delete(key);
    // Cached diagrams must be ready during the synchronous beforeprint render.
    for (const figure of figures()) {
      const text = source(figure);
      const svg = text === undefined ? undefined : cache.get(text);
      if (text !== undefined && svg !== undefined) replace(figure, text, svg);
    }
    void pump();
  };
  return {
    warm(sources: string[]) {
      if (disposed) return;
      wanted = new Set(sources);
      refresh();
    },
    refresh,
    dispose() {
      disposed = true;
      controller.abort();
      revision++;
      cache.clear();
      wanted.clear();
    },
  };
}
