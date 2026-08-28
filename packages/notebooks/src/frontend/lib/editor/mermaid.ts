import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import mermaid from "mermaid";
import {
  blockWidgetLineNavigationExtension,
  type CursorZoneState,
  cursorZoneStateField,
  selectionIntersectsRange,
} from "./_lib/cursor-zone-field";
import { notebookWorkspaceMessages } from "../../[id]/messages";

let isMermaidInitialized = false;

const initializeMermaid = () => {
  if (isMermaidInitialized) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;

  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    suppressErrorRendering: true,
    themeVariables: {
      fontFamily: "IBM Plex Mono",
      fontSize: "10px",
      // Keep full hex values to avoid shorthand parsing issues in strict Mermaid builds.
      textColor: "#111827",
      lineColor: "#6b7280",
      primaryTextColor: "#111827",
      secondaryTextColor: "#111827",
      tertiaryTextColor: "#111827",
      noteTextColor: "#111827",
      mainBkg: "#ffffff",
      secondBkg: "#f9fafb",
      tertiaryColor: "#f3f4f6",
    },
  });

  isMermaidInitialized = true;
};

const globalSvgCache = new Map<string, { svg: string; timestamp: number }>();
const SVG_CACHE_MAX = 50;

/** Constrain the first <svg> child of `host` so diagrams fit their
 *  wrapper without overflowing. Called from both render paths
 *  (cache-hit + fresh mermaid render); extracted to keep the two
 *  in sync. */
const applySvgConstraints = (host: HTMLElement): void => {
  const svg = host.querySelector("svg");
  if (!svg) return;
  svg.style.maxWidth = "90%";
  svg.style.maxHeight = "90%";
  svg.style.width = "auto";
  svg.style.height = "auto";
  svg.style.objectFit = "contain";
};

/** Single-pass min-by-timestamp over the cache. The previous
 *  `Array.from(...).sort()[0]` allocated + sorted the whole map
 *  on every overflow; this is O(n) with no allocation. */
const evictOldestSvg = (): void => {
  let oldestKey: string | undefined;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const [key, entry] of globalSvgCache) {
    if (entry.timestamp < oldestTs) {
      oldestTs = entry.timestamp;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) globalSvgCache.delete(oldestKey);
};

interface MermaidBlockParams {
  code: string;
  id: string;
  fromPos: number;
}

class MermaidWidget extends WidgetType {
  private code: string;
  private id: string;
  private cacheKey: string;
  private fromPos: number;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor({ code, id, fromPos }: MermaidBlockParams) {
    super();
    this.code = code;
    this.id = `mermaid-${id}`;
    this.cacheKey = code;
    this.fromPos = fromPos;
  }

  override eq(other: MermaidWidget) {
    return other.code === this.code && other.fromPos === this.fromPos;
  }

  override toDOM(view: EditorView) {
    const container = document.createElement("div");
    container.className = "cm-mermaid-widget !m-0";
    container.setAttribute("contenteditable", "false");
    container.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.fromPos }, scrollIntoView: true });
      view.focus();
    };

    const wrapper = document.createElement("div");
    wrapper.className =
      "rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-700 p-4 overflow-auto flex items-center justify-center";
    wrapper.style.height = "min(30vh, 400px)";
    wrapper.style.minHeight = "200px";

    const renderDiv = document.createElement("div");
    renderDiv.id = this.id;
    renderDiv.className = "flex justify-center items-center w-full h-full";

    const cached = globalSvgCache.get(this.cacheKey);
    if (cached && cached.svg) {
      // Cache hit: write the SVG straight in and skip the
      // mermaid.render call entirely. The cache key is a hash of
      // `this.code`, so a hit means the input is unchanged — a
      // re-render would just produce the same SVG. Bump the
      // timestamp so the LRU reflects "recently used", not
      // "recently fetched".
      renderDiv.innerHTML = cached.svg;
      applySvgConstraints(renderDiv);
      cached.timestamp = Date.now();
    } else {
      const loading = notebookWorkspaceMessages.resolve([document.documentElement.lang]).t.loadingDiagram;
      renderDiv.innerHTML = `
        <div class="flex items-center gap-2 text-gray-500">
          <i class="ti ti-loader animate-spin"></i>
          <span class="text-sm">${loading}</span>
        </div>`;
      // Only schedule the expensive mermaid.render (~50–200ms
      // Dagre layout) when there is nothing cached to display.
      this.debouncedRender(renderDiv);
    }

    wrapper.appendChild(renderDiv);
    container.appendChild(wrapper);
    return container;
  }

  /** Called by CM when the widget's DOM is being removed (user
   *  deleted the code block, scrolled it out of the viewport, or
   *  the doc changed enough to invalidate the decoration). Without
   *  this, the 500ms debounced timer keeps a reference to the
   *  detached element and fires `element.innerHTML = svg` on a
   *  node that is no longer in the document — wasted work that
   *  piles up on rapid edits. */
  override destroy(_dom: HTMLElement) {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
  }

  private debouncedRender(element: HTMLElement) {
    if (this.renderTimer) clearTimeout(this.renderTimer);

    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      this.renderDiagram(element);
    }, 500);
  }

  private async renderDiagram(element: HTMLElement) {
    try {
      initializeMermaid();
      const cached = globalSvgCache.get(this.cacheKey);
      const now = Date.now();
      const renderId = `${this.id}-${Date.now()}`;
      const { svg } = await mermaid.render(renderId, this.code);

      globalSvgCache.set(this.cacheKey, { svg, timestamp: now });

      if (globalSvgCache.size > SVG_CACHE_MAX) evictOldestSvg();

      if (!cached || cached.svg !== svg) {
        element.innerHTML = svg;
        element.className = "flex justify-center items-center w-full h-full";
        applySvgConstraints(element);
      }
    } catch (error) {
      const t = notebookWorkspaceMessages.resolve([document.documentElement.lang]).t;
      element.replaceChildren();
      const box = document.createElement("div");
      box.className = "flex flex-col items-center gap-2 text-red-500 p-4";

      const icon = document.createElement("i");
      icon.className = "ti ti-alert-circle text-2xl";

      const label = document.createElement("span");
      label.className = "text-sm font-mono";
      label.textContent = t.invalidMermaid;

      const details = document.createElement("details");
      details.className = "text-xs text-gray-500 max-w-full";

      const summary = document.createElement("summary");
      summary.className = "cursor-pointer hover:text-gray-700 dark:hover:text-gray-300";
      summary.textContent = t.showErrorDetails;

      const pre = document.createElement("pre");
      pre.className = "mt-2 p-2 bg-gray-100 dark:bg-gray-800 rounded text-left overflow-x-auto";
      pre.textContent = error instanceof Error ? error.message : String(error);

      details.append(summary, pre);
      box.append(icon, label, details);
      element.appendChild(box);
    }
  }

  override ignoreEvent() {
    return true;
  }

  override get estimatedHeight() {
    return 260;
  }
}

export const mermaidExtension = (): Extension => {
  const decorate = (state: EditorState): CursorZoneState => {
    const decorations: Range<Decoration>[] = [];
    const atomicDecorations: Range<Decoration>[] = [];
    const ranges: { from: number; to: number }[] = [];
    const cursor = state.selection.main;
    let widgetId = 0;

    syntaxTree(state).iterate({
      enter: ({ type, from, to }) => {
        if (type.name === "FencedCode") {
          const text = state.doc.sliceString(from, to);
          const lines = text.split("\n");
          const language =
            lines[0]
              ?.replace(/^(```|~~~)/, "")
              .trim()
              .toLowerCase() || "";

          if (language === "mermaid") {
            ranges.push({ from, to });
            if (selectionIntersectsRange(cursor, from, to)) return false;
            const code = lines.slice(1, -1).join("\n");
            const decoration = Decoration.replace({
              widget: new MermaidWidget({
                code,
                id: `${from}-${widgetId++}`,
                fromPos: from,
              }),
              block: true,
            }).range(from, to);
            decorations.push(decoration);
            atomicDecorations.push(decoration);
          }
        }
      },
    });

    return {
      decorations: decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none,
      atomicDecorations: atomicDecorations.length > 0 ? RangeSet.of(atomicDecorations, true) : Decoration.none,
      ranges,
      hasSyntax: ranges.length > 0,
    };
  };

  const mermaidField = cursorZoneStateField(decorate);

  return [mermaidField, blockWidgetLineNavigationExtension(mermaidField, (value) => value.atomicDecorations)];
};
