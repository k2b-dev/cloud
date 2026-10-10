import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { ScrollArea } from "@k2b/ui";
import { createComponent, render } from "solid-js/web";
import { yCollab } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { fadeScrollMarginsExtension, fadeScrollPadding } from "./fade-scroll-margins";
import { editor } from "./index";
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
      editor.searchTheme(),
      fadeScrollMarginsExtension(() => port),
      editor.customLightInit(),
      EditorView.theme({ ".cm-editor": { minHeight: "100%" }, ".cm-scroller": { width: "100%", minHeight: "100%", padding: "1rem" } }),
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

Object.assign(window, {
  harness: {
    scrollToMiddle,
    measure,
    placeCursor,
    settle,
  },
});
