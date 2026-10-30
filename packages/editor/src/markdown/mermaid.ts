import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, type EditorView, WidgetType } from "@codemirror/view";
import mermaid, { type MermaidConfig } from "mermaid";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  blockWidgetLineNavigationExtension,
  type CursorZoneState,
  cursorZoneStateField,
  selectionIntersectsRange,
} from "./_lib/cursor-zone-field";
import { codeFenceLanguage } from "./lib/markdown-fences";
import { MermaidEditorPreview, type MermaidPreviewState } from "./mermaid-preview";
import { renderMermaid } from "./mermaid-render";

const isDarkTheme = () => document.documentElement.classList.contains("dark");

/** Cached SVGs carry theme colors, so a theme switch must not reuse them. */
const svgCacheKey = (code: string) => `${isDarkTheme() ? "dark" : "light"}\n${code}`;

export type MermaidOptions = {
  /** The host's rendering policy and theme colors. */
  configuration: (options: { dark: boolean }) => MermaidConfig;
  /** Heading and file name used by the fullscreen/export controls. */
  title?: (markdown: string) => string | null;
  /** Locale of detached widget roots; omitted uses the inherited UI locale. */
  locale?: string;
};

const svgCaches = new WeakMap<MermaidOptions["configuration"], Map<string, { svg: string; timestamp: number }>>();
const SVG_CACHE_MAX = 50;

/** Single-pass min-by-timestamp over the cache. The previous
 *  `Array.from(...).sort()[0]` allocated + sorted the whole map
 *  on every overflow; this is O(n) with no allocation. */
const evictOldestSvg = (globalSvgCache: Map<string, { svg: string; timestamp: number }>): void => {
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
  private fromPos: number;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private dispose?: () => void;

  constructor(
    { code, id, fromPos }: MermaidBlockParams,
    private options: MermaidOptions,
    private globalSvgCache: Map<string, { svg: string; timestamp: number }>,
  ) {
    super();
    this.code = code;
    this.id = `mermaid-${id}`;
    this.fromPos = fromPos;
  }

  override eq(other: MermaidWidget) {
    return other.code === this.code && other.fromPos === this.fromPos;
  }

  override toDOM(view: EditorView) {
    const container = document.createElement("div");
    container.className = "cm-mermaid-widget !m-0";
    container.setAttribute("contenteditable", "false");
    const edit = () => {
      view.dispatch({ selection: { anchor: this.fromPos }, scrollIntoView: true });
      view.focus();
    };
    // At fit a press edits the source, as it always has. Zoomed in, a press
    // may start a pan, so only a click without dragging edits.
    const zoomedIn = () => container.querySelector(".k2b-zoom-pan[data-zoomed]") !== null;
    const onControl = (event: Event) => event.target instanceof Element && event.target.closest("button") !== null;
    container.onmousedown = (event) => {
      if (onControl(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!zoomedIn()) edit();
    };
    container.onclick = (event) => {
      if (!onControl(event) && zoomedIn()) edit();
    };

    const wrapper = document.createElement("div");
    wrapper.className = "rounded border border-[var(--ui-border)] bg-[var(--ui-surface)] overflow-hidden";
    wrapper.style.height = "min(30vh, 400px)";
    wrapper.style.minHeight = "200px";

    const cached = this.globalSvgCache.get(svgCacheKey(this.code));
    // Cache hit: show the SVG straight away and skip mermaid.render. The key is
    // the theme plus `this.code`, so a re-render would produce the same SVG.
    // Bump the timestamp so the LRU reflects "recently used".
    if (cached) cached.timestamp = Date.now();
    const [state, setState] = createSignal<MermaidPreviewState>(cached ? { kind: "ready", svg: cached.svg } : { kind: "loading" });
    this.dispose = render(
      () =>
        createComponent(MermaidEditorPreview, {
          state,
          title: () => this.options.title?.(view.state.doc.toString()) ?? null,
          configuration: this.options.configuration,
          locale: this.options.locale,
          exportSvg: () => this.renderExportSvg(),
        }),
      wrapper,
    );
    // Only schedule the expensive mermaid.render (~50–200ms Dagre layout)
    // when there is nothing cached to display.
    if (!cached) this.debouncedRender(setState);

    container.appendChild(wrapper);
    return container;
  }

  /** Called by CM when the widget's DOM is being removed (user
   *  deleted the code block, scrolled it out of the viewport, or
   *  the doc changed enough to invalidate the decoration). Without
   *  this, the 500ms debounced timer keeps a reference to the
   *  detached element and renders into a node that is no longer in
   *  the document — wasted work that piles up on rapid edits. */
  override destroy(_dom: HTMLElement) {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.dispose?.();
    this.dispose = undefined;
  }

  private debouncedRender(setState: (state: MermaidPreviewState) => void) {
    if (this.renderTimer) clearTimeout(this.renderTimer);

    this.renderTimer = setTimeout(() => {
      this.renderTimer = null;
      void this.renderDiagram(setState);
    }, 500);
  }

  private async renderDiagram(setState: (state: MermaidPreviewState) => void) {
    try {
      const cacheKey = svgCacheKey(this.code);
      const renderId = `${this.id}-${Date.now()}`;
      const { svg } = await renderMermaid(mermaid, this.options.configuration({ dark: isDarkTheme() }), renderId, this.code);

      this.globalSvgCache.set(cacheKey, { svg, timestamp: Date.now() });

      if (this.globalSvgCache.size > SVG_CACHE_MAX) evictOldestSvg(this.globalSvgCache);

      if (this.dispose) setState({ kind: "ready", svg });
    } catch (error) {
      if (this.dispose) setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Exports need SVG text labels: HTML labels (foreignObject) taint a canvas and
   *  render poorly outside a browser. */
  private async renderExportSvg(): Promise<string> {
    const config = this.options.configuration({ dark: isDarkTheme() });
    return (await renderMermaid(mermaid, { ...config, htmlLabels: false }, `${this.id}-export-${Date.now()}`, this.code)).svg;
  }

  override ignoreEvent() {
    return true;
  }

  override get estimatedHeight() {
    // The frame is min(30vh, 400px), with a 200px minimum; it includes its border.
    return Math.max(200, Math.min(window.innerHeight * 0.3, 400));
  }
}

export const mermaidExtension = (options: MermaidOptions): Extension => {
  let globalSvgCache = svgCaches.get(options.configuration);
  if (!globalSvgCache) {
    globalSvgCache = new Map();
    svgCaches.set(options.configuration, globalSvgCache);
  }
  const cache = globalSvgCache;
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
          const language = codeFenceLanguage(lines[0] ?? "");

          if (language === "mermaid") {
            ranges.push({ from, to });
            if (selectionIntersectsRange(cursor, from, to)) return false;
            const code = lines.slice(1, -1).join("\n");
            const decoration = Decoration.replace({
              widget: new MermaidWidget(
                {
                  code,
                  id: `${from}-${widgetId++}`,
                  fromPos: from,
                },
                options,
                cache,
              ),
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
