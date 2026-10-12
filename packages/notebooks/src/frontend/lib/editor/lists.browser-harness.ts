import { forceParsing } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ScrollArea } from "@k2b/ui";
import { createComponent, render } from "solid-js/web";
import { yCollab } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { fadeScrollMarginsExtension, fadeScrollPadding } from "./fade-scroll-margins";
import { editor } from "./index";
import { listCommandsExtension } from "./list-commands";
import { listStateField } from "./lists";
import { pressMissedEditor } from "./surface-press";

// The note editor's rich-mode arrangement: CodeMirror grows inside a fading ScrollArea whose surface takes stray presses.
let port: HTMLDivElement | undefined;
const host = document.createElement("div");
render(
  () =>
    createComponent(ScrollArea, {
      ref: (element: HTMLDivElement) => {
        port = element;
      },
      style: { height: "100dvh", "scroll-padding-block": fadeScrollPadding },
      // As in the note editor: a press on the surface that missed the editor puts the caret at the end.
      onMouseDown: (event: MouseEvent) => {
        if (!pressMissedEditor(event)) return;
        event.preventDefault();
        view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
        view.focus();
      },
      children: host,
    }),
  document.getElementById("root")!,
);

// A long note with paragraphs between the checklist items, so a task sits in the middle of the scroll range.
const doc = Array.from({ length: 40 }, (_, index) =>
  [
    `## Section ${index + 1}`,
    `Some prose for section ${index + 1} that fills the line.`,
    `- [ ] Task ${index + 1}`,
    `- [x] Done ${index + 1}`,
    "",
  ].join("\n"),
).join("\n");

const ydoc = new Y.Doc();
const ytext = ydoc.getText("codemirror");
ytext.insert(0, doc);
const view = new EditorView({
  parent: host,
  state: EditorState.create({
    doc,
    extensions: [
      yCollab(ytext, new Awareness(ydoc), { undoManager: new Y.UndoManager(ytext) }),
      editor.basicExtensions(),
      editor.markdownExtension(),
      listCommandsExtension(),
      editor.searchTheme(),
      fadeScrollMarginsExtension(() => port),
      editor.customLightInit(),
      editor.noteScrollerTheme,
      editor.tablesExtension("n1"),
      editor.imageExtension("n1"),
      editor.listsExtension(),
      editor.infoBlocksExtension("en"),
      editor.dataBlocksExtension(),
      editor.namedBlocksExtension(),
      editor.linksExtension("n1"),
      editor.markupExtension(),
      editor.markExtension(),
      editor.subSupExtension(),
      editor.ligaturesExtension(),
      editor.initialMarkdownDecorationRefreshExtension(),
      editor.pointerSelectionMarkdownRefreshExtension(),
      editor.mermaidExtension(),
      editor.katexExtension(),
      editor.codeFontExtension(),
      editor.tagPillExtension("n1"),
    ],
  }),
});

const lineOf = (task: string) => {
  for (let number = 1; number <= view.state.doc.lines; number++) {
    const line = view.state.doc.line(number);
    if (line.text.endsWith(` ${task}`)) return line;
  }
  throw new Error(`No line ends with "${task}".`);
};

/** Scrolls the note so the task's line sits in the middle of the screen; CodeMirror measures the lines it passes. */
const scrollToMiddle = (task: string) => {
  view.dispatch({ effects: EditorView.scrollIntoView(lineOf(task).from, { y: "center" }) });
};

/** The scroll position, where the task's line is on screen, its Markdown source, and the caret. */
const measure = (task: string) => {
  const line = lineOf(task);
  return {
    scrollTop: port!.scrollTop,
    windowScroll: window.scrollY,
    lineTop: view.documentTop + view.lineBlockAt(line.from).top,
    text: line.text,
    head: view.state.selection.main.head,
  };
};

const placeCursor = (task: string) => {
  view.dispatch({ selection: { anchor: lineOf(task).to } });
  view.focus();
};

/**
 * Waits until the note stops moving on its own: fonts have loaded, and CodeMirror has measured the lines it drew and
 * corrected the scroll position for them, so the scroll position and layout stay the same for several frames.
 */
const settle = async () => {
  await document.fonts.ready;
  let last = "";
  let stableFrames = 0;
  for (let frame = 0; frame < 120 && stableFrames < 5; frame++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = `${port!.scrollTop} ${view.documentTop} ${view.contentHeight}`;
    stableFrames = now === last ? stableFrames + 1 : 0;
    last = now;
  }
};

const loadDocument = (markdown: string) => {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: markdown }, selection: { anchor: 0 } });
  forceParsing(view, markdown.length, 5000);
  port!.scrollTop = 0;
};

const placeCaretOnLine = (number: number) => {
  view.dispatch({ selection: { anchor: view.state.doc.line(number).to } });
};

const measureLists = () => ({
  contentHeight: view.contentHeight,
  lines: view.state.field(listStateField).structure.items.map((item) => {
    const dom = view.domAtPos(item.contentFrom).node;
    const line = (dom instanceof Element ? dom : dom.parentElement)?.closest(".cm-line");
    if (!line) throw new Error(`List line ${item.line} is not rendered.`);
    const rect = line.getBoundingClientRect();
    const first = view.coordsAtPos(item.contentFrom, 1);
    if (!first) throw new Error(`No text coordinates on line ${item.line}.`);
    let wrappedX: number | null = null;
    const end = view.state.doc.line(item.line).to;
    for (let position = item.contentFrom + 1; position < end; position++) {
      const next = view.coordsAtPos(position, 1);
      if (next && next.top > first.top + 1) {
        wrappedX = next.left;
        break;
      }
    }
    return {
      line: item.line,
      depth: item.depth,
      textX: first.left,
      wrappedX,
      box: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      guides: Array.from(line.querySelectorAll(".custom-list-guide")).map((guide) => {
        const rect = guide.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, opacity: Number(getComputedStyle(guide).opacity) };
      }),
      label: line.querySelector(".custom-list-marker-ordered")?.textContent ?? null,
      checkbox: line.querySelector(".custom-list-task-marker") !== null,
    };
  }),
});

export type ListMeasurements = ReturnType<typeof measureLists>;

Object.assign(window, {
  harness: {
    loadDocument,
    placeCaret: (head: number) => {
      view.dispatch({ selection: { anchor: head } });
      view.focus();
    },
    readEditor: () => ({ doc: view.state.doc.toString(), head: view.state.selection.main.head }),
    placeCaretOnLine,
    measureLists,
    scrollToMiddle,
    measure,
    placeCursor,
    settle,
  },
});
