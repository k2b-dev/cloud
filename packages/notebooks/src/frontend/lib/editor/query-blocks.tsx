import { isolateHistory } from "@codemirror/commands";
import { setDiagnostics } from "@codemirror/lint";
import { type EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { type GeoDocument, serializeGeoDocument } from "@k2b/cloud/geo/document";
import { query, timed } from "@k2b/stdlib/solid";
import { Button } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { chartBlockFrame, notebookChartFrameHtml } from "../../../lib/chart-blocks";
import { parseNotebookMapBlocks, renderNotebookMapFigure } from "../../../lib/map-blocks";
import { extractNotebookDirectiveRanges } from "../../../lib/query-blocks";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../../[id]/_components/sidebar/workspace-events";
import { enhanceNotebookCharts } from "../notebook-charts";
import { enhanceNotebookMaps } from "../notebook-maps";
import {
  blockWidgetLineNavigationExtension,
  holdsDecorations,
  refreshMarkdownDecorationsEffect,
  selectionIntersectsRange,
} from "./_lib/cursor-zone-field";
import { queryBlockMessages } from "./query-block-messages";

export type BlockPreviewResult = {
  markdown: string;
  blocks: Array<{ line: number; html: string }>;
  diagnostics: Array<{ line: number; message: string }>;
  headings: Array<{ id: string; line: number }>;
};

type BlockRange = ReturnType<typeof extractNotebookDirectiveRanges>[number];
type ChartFrame = NonNullable<ReturnType<typeof chartBlockFrame>>;
type PreviewSnapshot = {
  result?: BlockPreviewResult;
  failed: boolean;
  locale: string;
  retry: () => void;
};

const previewEffect = StateEffect.define<PreviewSnapshot>();

class QueryBlockWidget extends WidgetType {
  private dispose?: () => void;
  private restoreCharts?: () => void;
  private restoreMaps?: () => void;
  private destroyed = false;

  constructor(
    private block: BlockRange,
    private snapshot: PreviewSnapshot,
    private html: string | undefined,
    private diagnostic?: string,
    private staleReadOnly = false,
    /** A chart's title and kind from its source: the frame stands while its drawing loads or fails. */
    private chart: ChartFrame | null = null,
    private map: GeoDocument | null = null,
    private notebookId = "",
    private mapSource = "",
  ) {
    super();
  }

  override eq(other: WidgetType) {
    return (
      other instanceof QueryBlockWidget &&
      other.block.from === this.block.from &&
      other.block.to === this.block.to &&
      other.html === this.html &&
      other.diagnostic === this.diagnostic &&
      other.staleReadOnly === this.staleReadOnly &&
      other.chart?.kind === this.chart?.kind &&
      other.chart?.area === this.chart?.area &&
      other.chart?.title === this.chart?.title &&
      other.chart?.subtitle === this.chart?.subtitle &&
      other.mapSource === this.mapSource &&
      other.snapshot.failed === this.snapshot.failed &&
      other.snapshot.locale === this.snapshot.locale &&
      other.snapshot.result?.headings === this.snapshot.result?.headings
    );
  }

  override toDOM(view: EditorView) {
    const t = queryBlockMessages.resolve([this.snapshot.locale]).t;
    const wrapper = document.createElement("div");
    wrapper.className = "cm-query-block-widget";
    wrapper.contentEditable = "false";
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-label", t[this.block.type]);
    const controls = document.createElement("div");
    controls.className = "flex justify-end gap-1 mb-1";
    const content = document.createElement("div");
    content.className = "cm-query-block-preview notebook-book-content";
    if (this.html !== undefined && !this.snapshot.failed) {
      content.innerHTML = this.html;
      // A drawn chart gets the same tooltips, table and Copy data as in Book.
      this.restoreCharts = enhanceNotebookCharts(content, this.snapshot.locale);
      let currentSource = view.state.sliceDoc(this.block.from, this.block.to);
      // MapView reads theme ancestors on mount, after CodeMirror attaches the widget.
      queueMicrotask(() => {
        if (this.destroyed || !content.isConnected) return;
        this.restoreMaps = enhanceNotebookMaps(
          content,
          this.snapshot.locale,
          view.state.readOnly
            ? undefined
            : (_previous, next) => {
                if (view.state.readOnly) return false;
                // A changed or moved block gets a new widget; never replace a different block with identical source.
                const matches = extractNotebookDirectiveRanges(view.state.doc.toString()).filter(
                  (block) =>
                    block.type === "map" && block.from === this.block.from && view.state.sliceDoc(block.from, block.to) === currentSource,
                );
                if (matches.length !== 1) return false;
                const block = matches[0]!;
                const insert = serializeGeoDocument(next);
                view.dispatch({
                  changes: { from: block.from, to: block.to, insert },
                  annotations: isolateHistory.of("full"),
                  userEvent: "input.map",
                });
                currentSource = insert;
                return true;
              },
        );
      });
    } else if (this.map) {
      // Source-owned geometry and links reserve the map/list box while the canonical preview is pending.
      // No map requests or editing controls mount before that authorized response arrives.
      content.innerHTML = renderNotebookMapFigure(this.map, { locale: this.snapshot.locale, notebookId: this.notebookId });
      if (!view.state.readOnly && (!this.map.route || this.map.pins.length)) {
        const search = document.createElement("div");
        search.className = "notebook-map__search-placeholder";
        search.setAttribute("aria-hidden", "true");
        content.querySelector(".notebook-map__body")?.prepend(search);
      }
      const status = content.querySelector<HTMLElement>(".notebook-map__placeholder");
      if (status) status.textContent = this.snapshot.failed ? t.failed : this.staleReadOnly ? t.savedChanged : t.loading;
    } else if (this.chart) {
      // The frame keeps the drawn chart's height, so loading, a failure or a reload message never moves the note.
      const status = document.createElement("p");
      status.className = "notebook-book-chart__status text-sm text-dimmed";
      status.setAttribute("role", "status");
      status.textContent = this.snapshot.failed ? t.failed : this.staleReadOnly ? t.savedChanged : (this.diagnostic ?? t.loading);
      content.innerHTML = notebookChartFrameHtml(this.chart, "");
      content.querySelector(".notebook-book-chart__viewport")?.append(status);
    } else {
      content.className += " text-sm text-dimmed";
      content.setAttribute("role", "status");
      content.textContent = this.snapshot.failed ? t.failed : this.staleReadOnly ? t.savedChanged : (this.diagnostic ?? t.loading);
    }
    wrapper.append(controls, content);
    const reveal = () => {
      view.dispatch({ selection: { anchor: this.block.from }, scrollIntoView: true });
      view.focus();
    };
    this.dispose = render(
      () => (
        <>
          {this.staleReadOnly && (
            <Button size="xs" variant="ghost" onClick={() => window.location.reload()}>
              {t.reload}
            </Button>
          )}
          {this.snapshot.failed && (
            <Button size="xs" variant="ghost" onClick={this.snapshot.retry}>
              {t.retry}
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={reveal}>
            {t.showSource}
          </Button>
        </>
      ),
      controls,
    );
    // Interactive preview content owns pointer events; never place the editor
    // cursor through a rendered link or control underneath the widget.
    wrapper.addEventListener("mousedown", (event) => event.stopPropagation());
    wrapper.addEventListener("click", (event) => {
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      const href = anchor?.getAttribute("href");
      if (!href?.startsWith("#")) return;
      event.preventDefault();
      event.stopPropagation();
      const heading = this.snapshot.result?.headings.find((entry) => entry.id === href.slice(1));
      if (!heading || heading.line < 1 || heading.line > view.state.doc.lines) {
        content.querySelector(".cm-query-heading-unavailable")?.remove();
        const status = document.createElement("p");
        status.className = "cm-query-heading-unavailable text-sm text-dimmed";
        status.setAttribute("role", "status");
        status.textContent = t.headingUnavailable;
        content.append(status);
        return;
      }
      view.dispatch({ selection: { anchor: view.state.doc.line(heading.line).from }, scrollIntoView: true });
      view.focus();
    });
    return wrapper;
  }

  override destroy() {
    this.destroyed = true;
    this.dispose?.();
    this.restoreCharts?.();
    this.restoreMaps?.();
  }
  override ignoreEvent() {
    return true;
  }
  override get estimatedHeight() {
    // Widget margins, border, padding and controls (66px), the title row beside the chart's 28px controls and the
    // kind's fixed frame (app.css).
    if (this.map) return this.map.route && !this.map.pins.length ? 66 + 30 + 10 + 240 : 66 + 30 + 10 + 36 + 10 + 320 + 10 + 176;
    if (this.chart) return 66 + (this.chart.subtitle ? 44 : 28) + 8 + (this.chart.kind === "stat" ? 160 : 288);
    // Query tables have 14px / 21px text, 16px cell padding and row dividers;
    // controls, widget padding/border and table spacing add 65px.
    // The truncated count paragraph inherits 16px / 1.6 text (25.6px) in
    // `.cm-query-block-preview.notebook-book-content` and 1rem block margins
    // from app.css. Its top margin collapses with the table's bottom margin,
    // so it adds one line plus one 16px margin: 41.6px.
    const rows = this.snapshot.failed ? 0 : (this.html?.match(/<tr(?:\s|>)/g)?.length ?? 0);
    const countHeight = this.html?.includes('<p class="notebook-book-empty">') ? 41.6 : 0;
    return rows ? rows * 38 + 65 + countHeight : 120;
  }
}

type BlockState = { decorations: DecorationSet; snapshot: PreviewSnapshot; ranges: BlockRange[] };

/** A single Solid-owned canonical query serves all blocks in one editor. */
export function createQueryBlockPreviews(options: {
  notebookId: string;
  noteId: string;
  readOnly: boolean;
  initialMarkdown: string;
  view: Accessor<EditorView | undefined>;
  enabled: Accessor<boolean>;
  locale: Accessor<string>;
  load: (markdown: string | undefined, signal: AbortSignal) => Promise<BlockPreviewResult>;
}): { extension: Extension; listener: Extension } {
  const [markdown, setMarkdown] = createSignal(options.initialMarkdown.replace(/\r\n?/g, "\n"));
  const [ready, setReady] = createSignal(true);
  const hasBlocks = createMemo(() => extractNotebookDirectiveRanges(markdown()).length > 0);
  const previews = query.create({
    source: () => `${options.notebookId}/${options.noteId}`,
    enabled: () => options.enabled() && hasBlocks() && ready(),
    load: (_source, { abortSignal }) => options.load(options.readOnly ? undefined : markdown(), abortSignal),
    subscribe: ({ invalidate }) => {
      const handle = (raw: Event) => {
        const detail = (raw as CustomEvent<WorkspaceEventDetail>).detail;
        if (detail.event.notebookId !== options.notebookId || !options.enabled() || !hasBlocks()) return;
        if (detail.event.type === "note.comments.changed" || detail.event.type === "note.favorite.changed") return;
        detail.cover(invalidate());
      };
      window.addEventListener(WORKSPACE_EVENT, handle);
      return () => window.removeEventListener(WORKSPACE_EVENT, handle);
    },
  });
  const update = timed.debounce(() => {
    setReady(true);
    if (hasBlocks()) void previews.invalidate().catch(() => undefined);
    else previews.abort();
  }, 300);
  let snapshot: PreviewSnapshot = { failed: false, locale: options.locale(), retry: () => void previews.refresh() };
  // The last drawing of each chart, by its source: an edit elsewhere keeps it in place until the new preview arrives.
  let drawnCharts = new Map<string, string>();
  const build = (state: EditorState, next: PreviewSnapshot): BlockState => {
    const document = state.doc.toString();
    const result = next.result?.markdown === document ? next.result : undefined;
    const ranges: Range<Decoration>[] = [];
    const blocks = extractNotebookDirectiveRanges(document);
    if (result)
      drawnCharts = new Map(
        blocks.flatMap((block) => {
          const html = block.type === "chart" ? result.blocks.find((entry) => entry.line === block.line)?.html : undefined;
          return html === undefined ? [] : [[document.slice(block.from, block.to), html] as const];
        }),
      );
    for (const block of blocks) {
      if (selectionIntersectsRange(state.selection.main, block.from, block.to)) continue;
      const source = block.type === "chart" ? document.slice(block.from, block.to) : "";
      const html = result?.blocks.find((entry) => entry.line === block.line)?.html ?? (source ? drawnCharts.get(source) : undefined);
      const map = block.type === "map" ? (parseNotebookMapBlocks(document.slice(block.from, block.to)).blocks[0]?.document ?? null) : null;
      const chart = block.type === "chart" ? chartBlockFrame(source.split("\n").slice(1, block.closed ? -1 : undefined)) : null;
      const diagnostic = result?.diagnostics
        .filter((entry) => entry.line >= block.line && entry.line <= state.doc.lineAt(block.to).number)
        .map((entry) => entry.message)
        .join("\n");
      ranges.push(
        Decoration.replace({
          widget: new QueryBlockWidget(
            block,
            { ...next, result },
            html,
            diagnostic || undefined,
            options.readOnly && !!next.result && !result,
            chart,
            map,
            options.notebookId,
            map ? document.slice(block.from, block.to) : "",
          ),
          block: true,
        }).range(block.from, block.to),
      );
    }
    return { decorations: Decoration.set(ranges, true), snapshot: next, ranges: blocks };
  };
  const field = StateField.define<BlockState>({
    create: (state) => build(state, snapshot),
    update(value, tr) {
      const effect = tr.effects.find((effect) => effect.is(previewEffect));
      if (effect?.is(previewEffect)) return build(tr.state, effect.value);
      if (tr.docChanged || tr.effects.some((effect) => effect.is(refreshMarkdownDecorationsEffect))) return build(tr.state, value.snapshot);
      if (holdsDecorations(tr)) return value;
      if (
        tr.selection &&
        value.ranges.some(
          (range) =>
            selectionIntersectsRange(tr.startState.selection.main, range.from, range.to) !==
            selectionIntersectsRange(tr.state.selection.main, range.from, range.to),
        )
      )
        return build(tr.state, value.snapshot);
      return value;
    },
    provide: (field) => [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
    ],
  });
  let disposed = false;
  let queued = false;
  onCleanup(() => {
    disposed = true;
  });
  createEffect(() => {
    snapshot = { result: previews.data(), failed: !!previews.error(), locale: options.locale(), retry: () => void previews.refresh() };
    const view = options.view();
    options.enabled();
    markdown();
    if (!view || queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (disposed) return;
      if (view.state.field(field, false)) view.dispatch({ effects: previewEffect.of(snapshot) });
      const diagnostics = snapshot.result?.markdown === view.state.doc.toString() ? snapshot.result.diagnostics : [];
      view.dispatch(
        setDiagnostics(
          view.state,
          diagnostics.map((diagnostic) => {
            const line = view.state.doc.line(Math.max(1, Math.min(diagnostic.line, view.state.doc.lines)));
            return { from: line.from, to: line.to, severity: "error", message: diagnostic.message };
          }),
        ),
      );
    });
  });
  return {
    extension: [
      field,
      // The widget's box lives in app.css: the note's server preview reserves the same box for a chart.
      blockWidgetLineNavigationExtension(field, (value) => value.decorations),
    ],
    listener: EditorView.updateListener.of((event) => {
      if (!event.docChanged) return;
      setReady(false);
      setMarkdown(event.state.doc.toString());
      update.debouncedFn();
    }),
  };
}
