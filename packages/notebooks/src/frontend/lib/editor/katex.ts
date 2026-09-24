import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range, Transaction } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import katex from "katex";
import {
  blockWidgetLineNavigationExtension,
  type CursorZoneState,
  cursorZoneStateField,
  selectionIntersectsRange,
} from "./_lib/cursor-zone-field";
import { blockMathPattern, inlineMathPattern } from "./_lib/math-syntax";

// =============================================================================
// Module-scoped render cache
// =============================================================================
//
// KaTeX is fast (~1–5ms per formula), but on a Numpy-style note with 50+
// formulas, repeatedly re-rendering on scroll-past-and-back adds up. CM's
// widget reuse handles the in-viewport case via `eq()`, but widgets that
// scroll out of the viewport are destroyed + recreated → fresh katex.render
// every time. Cache the rendered DOM keyed by (mode, latex) and hand out
// deep clones so callers can insert without aliasing.
//
// `cloneNode(true)` is safe here: katex output is plain spans + divs with
// CSS classes (no event handlers, no shadow DOM, no canvas). The font
// references live in global stylesheets so classes survive the clone.

type RenderEntry = { node: HTMLElement; timestamp: number };
const RENDER_CACHE_MAX = 200;
const renderCache = new Map<string, RenderEntry>();

/** Single-pass min-by-timestamp eviction (mirrors mermaid's
 *  `evictOldestSvg`). LRU keeps the working set hot without
 *  scanning + sorting on every overflow. */
const evictOldestRender = (): void => {
  let oldestKey: string | undefined;
  let oldestTs = Number.POSITIVE_INFINITY;
  for (const [k, e] of renderCache) {
    if (e.timestamp < oldestTs) {
      oldestTs = e.timestamp;
      oldestKey = k;
    }
  }
  if (oldestKey !== undefined) renderCache.delete(oldestKey);
};

/** Render LaTeX to a detached DOM element (block or inline). On
 *  cache hit, returns a deep clone of the cached prototype and
 *  bumps its timestamp for LRU. On miss, runs `katex.render` once,
 *  caches the prototype, returns a clone. Returns `null` if katex
 *  throws (rare with `throwOnError: false`, but defensive) so the
 *  caller can render the error fallback instead. */
const tryRenderKatex = (latex: string, displayMode: boolean): HTMLElement | null => {
  const key = `${displayMode ? "B" : "I"}:${latex}`;
  const entry = renderCache.get(key);
  if (entry) {
    entry.timestamp = Date.now();
    return entry.node.cloneNode(true) as HTMLElement;
  }
  // Use a `div` host for block math (katex-display wraps as block)
  // and a `span` for inline so the natural flow keeps inline math
  // inline.
  const prototype = document.createElement(displayMode ? "div" : "span");
  try {
    katex.render(latex, prototype, { throwOnError: false, displayMode });
  } catch {
    return null;
  }
  renderCache.set(key, { node: prototype, timestamp: Date.now() });
  if (renderCache.size > RENDER_CACHE_MAX) evictOldestRender();
  return prototype.cloneNode(true) as HTMLElement;
};

class InlineMathWidget extends WidgetType {
  constructor(private latex: string) {
    super();
  }

  override toDOM() {
    const rendered = tryRenderKatex(this.latex, false);
    const span = rendered ?? document.createElement("span");
    span.className = "cm-katex-inline";
    if (!rendered) {
      span.innerHTML = `<span class="cm-katex-error text-red-500">$${this.latex}$</span>`;
    }
    return span;
  }

  override ignoreEvent(event: Event) {
    return event.type !== "mousedown";
  }

  override eq(other: WidgetType) {
    return other instanceof InlineMathWidget && other.latex === this.latex;
  }
}

class BlockMathWidget extends WidgetType {
  constructor(
    private latex: string,
    private fromPos: number,
  ) {
    super();
  }

  override toDOM(view: EditorView) {
    const container = document.createElement("div");
    container.className = "cm-katex-block !m-0";
    container.setAttribute("contenteditable", "false");
    container.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.fromPos }, scrollIntoView: true });
      view.focus();
    };
    container.ondblclick = (event) => {
      event.stopPropagation();
    };

    const wrapper = document.createElement("div");
    wrapper.className = "p-1 overflow-x-auto flex items-center justify-center";

    const rendered = tryRenderKatex(this.latex, true);
    const mathDiv = rendered ?? document.createElement("div");
    mathDiv.className = "text-center";
    if (!rendered) {
      mathDiv.innerHTML = `
        <div class="text-red-500 font-mono text-sm">
          <i class="ti ti-alert-circle"></i> Invalid LaTeX
          <pre class="mt-2">${this.latex}</pre>
        </div>`;
    }

    wrapper.appendChild(mathDiv);
    container.appendChild(wrapper);
    return container;
  }

  override eq(other: WidgetType) {
    return other instanceof BlockMathWidget && other.latex === this.latex && other.fromPos === this.fromPos;
  }

  override ignoreEvent() {
    return true;
  }
}

const hasMathMarker = (text: string): boolean => text.includes("$") || text.includes("\\");

/** Predicate for the incremental cursor-zone mode. Cheap O(insert + 4)
 *  scan to decide whether a doc change might introduce or remove a
 *  math marker — `$` or `\` in the inserted text or the ±2 char
 *  window around it. False positives (e.g. typing `$` inside code)
 *  fall back to a baseline rebuild; false negatives would leave
 *  stale decorations, so the predicate is intentionally generous. */
const changesMightAffectMath = (tr: Transaction): boolean => {
  let might = false;
  tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
    if (might) return;
    if (hasMathMarker(inserted.toString())) {
      might = true;
      return;
    }
    const from = Math.max(0, fromB - 2);
    const to = Math.min(tr.state.doc.length, toB + 2);
    might = hasMathMarker(tr.state.doc.sliceString(from, to));
  });
  return might;
};

const intersectsAnyRange = (ranges: { from: number; to: number }[], from: number, to: number): boolean =>
  ranges.some(
    (range) => (from >= range.from && from < range.to) || (to > range.from && to <= range.to) || (from <= range.from && to >= range.to),
  );

const buildKatexDecorations = (state: EditorState): CursorZoneState => {
  const decorations: Range<Decoration>[] = [];
  const atomicDecorations: Range<Decoration>[] = [];
  const cursor = state.selection.main;
  const doc = state.doc.toString();
  let hasSyntax = false;
  const ranges: { from: number; to: number }[] = [];

  const codeRanges: { from: number; to: number }[] = [];

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.type.name === "FencedCode") {
        codeRanges.push({ from: node.from, to: node.to });

        const text = state.sliceDoc(node.from, node.to);
        const lines = text.split("\n");
        const language =
          lines[0]
            ?.replace(/^(```|~~~)/, "")
            .trim()
            .toLowerCase() || "";

        if (language === "math") {
          hasSyntax = true;
          const prevLine = state.doc.lineAt(Math.max(node.from - 1, 0));
          const nextLine = state.doc.lineAt(Math.min(node.to + 1, state.doc.length));
          ranges.push({ from: prevLine.from, to: nextLine.to });
          if (selectionIntersectsRange(cursor, prevLine.from, nextLine.to)) return false;
          const latex = lines.slice(1, -1).join("\n");
          const blockDecoration = Decoration.replace({
            widget: new BlockMathWidget(latex, node.from),
            block: true,
          }).range(node.from, node.to);
          decorations.push(blockDecoration);
          atomicDecorations.push(blockDecoration);
        }
      }
      if (node.type.name === "InlineCode") {
        codeRanges.push({ from: node.from, to: node.to });
      }
    },
  });

  /**
   * Walk a global regex over the doc, push a decoration per match
   * UNLESS the match falls inside a code range (handled separately)
   * or the cursor sits inside it (= edit mode for that math snippet).
   *
   * CRITICAL: advance `match = re.exec(doc)` BEFORE any `continue`.
   * The regex's `lastIndex` only moves when `.exec` runs; a `continue`
   * after a skip-decision without re-exec would pin the regex on the
   * same match → infinite loop → tab freeze. Observed when the doc
   * contained a `$$…$$` or `\[…\]` inside a code block.
   */
  const scanMath = (re: RegExp, makeWidget: (latex: string, from: number) => WidgetType, blockWidget: boolean) => {
    let match: RegExpExecArray | null = re.exec(doc);
    while (match !== null) {
      const from = match.index;
      const to = from + match[0].length;
      const latex = match[1] ?? match[2] ?? "";
      hasSyntax = true;
      let sourceVisibleFrom = from;
      let sourceVisibleTo = to;
      if (blockWidget) {
        const fromLine = state.doc.lineAt(from);
        const toLine = state.doc.lineAt(to);
        if (from !== fromLine.from || to !== toLine.to) {
          match = re.exec(doc);
          continue;
        }
        const prevLine = state.doc.lineAt(Math.max(from - 1, 0));
        const nextLine = state.doc.lineAt(Math.min(to + 1, state.doc.length));
        sourceVisibleFrom = prevLine.from;
        sourceVisibleTo = nextLine.to;
        ranges.push({ from: sourceVisibleFrom, to: sourceVisibleTo });
      } else {
        ranges.push({ from, to });
      }
      const cursorInside = selectionIntersectsRange(cursor, sourceVisibleFrom, sourceVisibleTo);
      const skip = intersectsAnyRange(codeRanges, from, to) || cursorInside;
      match = re.exec(doc);
      if (skip) continue;
      const decoration = Decoration.replace(
        blockWidget ? { widget: makeWidget(latex, from), block: true } : { widget: makeWidget(latex, from) },
      ).range(from, to);
      decorations.push(decoration);
      if (blockWidget) atomicDecorations.push(decoration);
    }
  };

  scanMath(blockMathPattern(), (latex, from) => new BlockMathWidget(latex, from), true);
  scanMath(inlineMathPattern(), (latex) => new InlineMathWidget(latex), false);

  return {
    decorations: decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none,
    atomicDecorations: atomicDecorations.length > 0 ? RangeSet.of(atomicDecorations, true) : Decoration.none,
    ranges,
    hasSyntax,
  };
};

export const katexExtension = (): Extension => {
  const stateField = cursorZoneStateField(buildKatexDecorations, {
    changesMightAffectSyntax: changesMightAffectMath,
  });

  const theme = EditorView.theme({
    ".cm-katex-inline": {
      display: "inline-block",
      padding: "0 4px",
      borderRadius: "var(--radius-sm)",
      lineHeight: "1",
    },
    ".cm-katex-inline:hover": { background: "rgba(59, 130, 246, 0.05)" },
    ".cm-katex-block": {
      display: "block",
      margin: "0 !important",
      borderRadius: "var(--radius-sm)",
    },
    ".cm-katex-block:hover": { background: "rgba(59, 130, 246, 0.05)" },
    ".cm-katex-error": {
      fontFamily: "var(--font-mono)",
      fontSize: "0.875em",
      padding: "0 2px",
    },
  });

  return [stateField, blockWidgetLineNavigationExtension(stateField, (value) => value.atomicDecorations), theme];
};
