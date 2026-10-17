import { forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, WidgetType } from "@codemirror/view";
import { ScrollArea } from "@k2b/ui";
import { createRoot, createSignal } from "solid-js";
import { createComponent, render } from "solid-js/web";
import { fadeScrollMarginsExtension, fadeScrollPadding } from "./fade-scroll-margins";
import { editor } from "./index";
import { listCommandsExtension } from "./list-commands";
import { createQueryBlockPreviews } from "./query-blocks";

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "write";
const dark = document.documentElement.classList.contains("dark");
let port: HTMLDivElement | undefined;
let view: EditorView | undefined;

if (mode !== "book")
  createRoot(() => {
    const host = document.createElement("div");
    render(
      () =>
        createComponent(ScrollArea, {
          ref: (element: HTMLDivElement) => {
            port = element;
          },
          class: "relative min-h-0 flex-1 cursor-text",
          style: { "scroll-padding-block": fadeScrollPadding },
          children: host,
        }),
      document.getElementById("main")!,
    );
    const doc = document.getElementById("note-source")!.textContent!;
    const [currentView, setCurrentView] = createSignal<EditorView>();
    const previews = params.has("queryRows")
      ? createQueryBlockPreviews({
          notebookId: "book01",
          noteId: "note01",
          readOnly: false,
          initialMarkdown: doc,
          view: currentView,
          enabled: () => true,
          locale: () => "de",
          load: async () => ({
            markdown: doc,
            blocks: [{ line: 3, html: await (await fetch(`/query-html?${params}`)).text() }],
            diagnostics: [],
            headings: [],
          }),
        })
      : undefined;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [
          editor.basicExtensions(),
          editor.markdownExtension(),
          editor.searchTheme(),
          fadeScrollMarginsExtension(() => port),
          editor.noteScroller,
          previews ? [previews.extension, previews.listener] : [],
          mode === "source"
            ? [editor.rawLightInit(), lineNumbers()]
            : [
                dark ? editor.customDarkInit() : editor.customLightInit(),
                listCommandsExtension(),
                editor.tablesExtension("book01"),
                editor.imageExtension("book01"),
                editor.listsExtension(),
                editor.infoBlocksExtension("de"),
                editor.dataBlocksExtension(),
                editor.namedBlocksExtension(),
                editor.linksExtension("book01"),
                editor.markupExtension(),
                editor.markExtension(),
                editor.subSupExtension(),
                editor.ligaturesExtension(),
                editor.initialMarkdownDecorationRefreshExtension(),
                editor.pointerSelectionMarkdownRefreshExtension(),
                editor.mermaidExtension(),
                editor.katexExtension(),
                editor.codeFontExtension(),
                editor.tagPillExtension("book01"),
              ],
        ],
      }),
    });
    setCurrentView(view);
    forceParsing(view, doc.length, 5000);
  });

const settle = async () => {
  await document.fonts.ready;
  let last = "";
  let stableFrames = 0;
  for (let frame = 0; frame < 120 && stableFrames < 5; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = `${port?.scrollTop} ${view?.documentTop} ${view?.contentHeight} ${document.getElementById("main")!.scrollHeight}`;
    stableFrames = now === last ? stableFrames + 1 : 0;
    last = now;
  }
};

const paragraph = (prefix: string) => {
  const element = Array.from(document.querySelectorAll(mode === "book" ? "article > p" : ".cm-line")).find((line) =>
    line.textContent?.startsWith(prefix),
  );
  if (!element) throw new Error(`The fixture paragraph is not rendered: ${prefix}`);
  return element;
};

const measure = (prefix = "Unser Team") => {
  const element = paragraph(prefix);
  const rect = element.getBoundingClientRect();
  const owner = mode === "book" ? document.getElementById("main")! : view!.scrollDOM;
  const box = owner.getBoundingClientRect();
  const style = getComputedStyle(owner);
  const lines: { top: number; left: number; right: number; text: string }[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const range = document.createRange();
    const text = node.textContent!;
    for (let offset = 0; offset < text.length; offset++) {
      range.setStart(node, offset);
      range.setEnd(node, offset + 1);
      const fragment = range.getBoundingClientRect();
      const line = lines.find((line) => Math.abs(line.top - fragment.top) < 1);
      // Measure visible words only: pre-wrap lets trailing spaces hang, while Book prose collapses them.
      if (line) {
        line.text += text[offset];
        if (!/\s/.test(text[offset]!)) {
          line.left = Math.min(line.left, fragment.left);
          line.right = Math.max(line.right, fragment.right);
        }
      } else if (!/\s/.test(text[offset]!)) {
        lines.push({ top: fragment.top, left: fragment.left, right: fragment.right, text: text[offset]! });
      }
    }
  }
  return {
    left: rect.left,
    width: rect.width,
    height: rect.height,
    gaps: [
      rect.left - box.left - Number.parseFloat(style.paddingLeft),
      box.left + owner.clientWidth - Number.parseFloat(style.paddingRight) - rect.right,
    ],
    lines: lines.map((line) => line.right - line.left),
    breaks: lines.map((line) => line.text.trim()),
    fontSize: getComputedStyle(element).fontSize,
    lineHeight: getComputedStyle(element).lineHeight,
  };
};

const harness = {
  settle,
  measure,
  hideNavigation: () => {
    document.getElementById("navigation")!.hidden = true;
  },
  loadDocument: (doc: string) => {
    if (!view) throw new Error("No editor on the Book page.");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: doc }, selection: { anchor: doc.length } });
    forceParsing(view, doc.length, 5000);
    port!.scrollTop = 0;
  },
  anchor: () => view!.state.selection.main.anchor,
  /** Puts the caret at the end of the paragraph's first visual line. */
  caretAtWrap: (prefix: string) => {
    const from = view!.state.doc.toString().indexOf(prefix);
    if (from < 0) throw new Error(`No paragraph: ${prefix}`);
    const end = view!.moveToLineBoundary(EditorSelection.cursor(from), true, true);
    const head = view!.state.sliceDoc(end.head - 1, end.head) === " " ? end.head - 1 : end.head;
    view!.dispatch({ selection: EditorSelection.cursor(head, -1) });
    view!.focus();
  },
  /** The text's left edge and every scroll offset sideways, from the editor up to the page. */
  sideways: () => {
    const offsets: number[] = [];
    for (let element: Element | null = view!.contentDOM; element; element = element.parentElement) offsets.push(element.scrollLeft);
    return { left: view!.contentDOM.getBoundingClientRect().left, offsets };
  },
  scrollTo: (text: string) => {
    if (!view) throw new Error("No editor on the Book page.");
    const from = view.state.doc.toString().indexOf(text);
    if (from < 0) throw new Error(`No anchor: ${text}`);
    view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "center" }) });
  },
  widgetHeights: () =>
    Array.from(
      document.querySelectorAll(
        ".cm-table-widget, .cm-mermaid-widget, .cm-notice-card-widget, .cm-data-block-widget, .cm-query-block-widget",
      ),
      (element) => ({
        kind: element.classList[0],
        height: element.getBoundingClientRect().height,
      }),
    ),
  widgetEstimates: () => {
    const estimates: { kind: string; height: number }[] = [];
    for (const decorations of view!.state.facet(EditorView.decorations)) {
      if (typeof decorations === "function") continue;
      decorations.between(0, view!.state.doc.length, (_from, _to, decoration) => {
        const widget = decoration.spec.widget;
        if (widget instanceof WidgetType && widget.estimatedHeight >= 0)
          estimates.push({ kind: widget.constructor.name, height: widget.estimatedHeight });
      });
    }
    return estimates;
  },
  scrollAnchor: async (text: string) => {
    const from = view!.state.doc.toString().indexOf(text);
    if (from < 0) throw new Error(`No anchor: ${text}`);
    const top = () => view!.documentTop + view!.lineBlockAt(from).top - port!.getBoundingClientRect().top;
    port!.scrollTop += top() - port!.clientHeight / 2;
    const expected = top();
    const painted: number[] = [];
    for (let frame = 0; frame < 8; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const line = Array.from(view!.contentDOM.querySelectorAll(".cm-line")).find((line) => line.textContent === text);
      if (line) painted.push(line.getBoundingClientRect().top - port!.getBoundingClientRect().top);
    }
    return { expected, painted };
  },
};

export type ReadingColumnHarness = typeof harness;
Object.assign(window, { harness });
