import { setDiagnostics } from "@codemirror/lint";
import { type EditorState, type Extension, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { query, timed } from "@k2b/stdlib/solid";
import { Button } from "@k2b/ui";
import { type Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import { extractNotebookDirectiveRanges } from "../../../lib/query-blocks";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../../[id]/_components/sidebar/workspace-events";
import { blockWidgetLineNavigationExtension, refreshMarkdownDecorationsEffect, selectionIntersectsRange } from "./_lib/cursor-zone-field";
import { queryBlockMessages } from "./query-block-messages";

export type BlockPreviewResult = {
  markdown: string;
  blocks: Array<{ line: number; html: string }>;
  diagnostics: Array<{ line: number; message: string }>;
  headings: Array<{ id: string; line: number }>;
};

type BlockRange = ReturnType<typeof extractNotebookDirectiveRanges>[number];
type PreviewSnapshot = {
  result?: BlockPreviewResult;
  failed: boolean;
  locale: string;
  retry: () => void;
};

const previewEffect = StateEffect.define<PreviewSnapshot>();

class QueryBlockWidget extends WidgetType {
  private dispose?: () => void;

  constructor(
    private block: BlockRange,
    private snapshot: PreviewSnapshot,
    private html: string | undefined,
    private diagnostic?: string,
    private staleReadOnly = false,
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
    if (this.html !== undefined && !this.snapshot.failed) content.innerHTML = this.html;
    else {
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
    this.dispose?.();
  }
  override ignoreEvent() {
    return true;
  }
  override get estimatedHeight() {
    return 120;
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
  const build = (state: EditorState, next: PreviewSnapshot): BlockState => {
    const document = state.doc.toString();
    const result = next.result?.markdown === document ? next.result : undefined;
    const ranges: Range<Decoration>[] = [];
    const blocks = extractNotebookDirectiveRanges(document);
    for (const block of blocks) {
      if (selectionIntersectsRange(state.selection.main, block.from, block.to)) continue;
      const html = result?.blocks.find((entry) => entry.line === block.line)?.html;
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
      blockWidgetLineNavigationExtension(field, (value) => value.decorations),
      EditorView.theme({
        ".cm-query-block-widget": {
          display: "block",
          margin: "0.5rem 0",
          padding: "0.5rem",
          border: "1px solid var(--ui-border)",
          borderRadius: "var(--radius-md)",
        },
        ".cm-query-block-preview": { overflowX: "auto" },
      }),
    ],
    listener: EditorView.updateListener.of((event) => {
      if (!event.docChanged) return;
      setReady(false);
      setMarkdown(event.state.doc.toString());
      update.debouncedFn();
    }),
  };
}
