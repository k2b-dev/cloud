import { EditorSelection, EditorState } from "@codemirror/state";
import { BlockType, EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { handleSoftNoteNavigationRequests } from "../soft-navigation";
import { pointerSelectionHeld } from "./_lib/cursor-zone-field";
import { editor } from "./index";
import { remoteCursors } from "./remote-cursors";

const doc = [
  "# Project heading",
  "",
  "Some **bold** text and a [web link](https://example.com) inside prose, then *italic* words here.",
  "",
  "- First bullet item with text",
  "- [ ] Open task item",
  "- [x] Done task item",
  "",
  "| Name | Value |",
  "| --- | --- |",
  "| Alpha | 1 |",
  "",
  "Final paragraph with plain words to select.",
  "",
  "Tagged #mytag, [Other note](note://abc123) and [mail me](mailto:ada@example.com) then more plain trailing words here.",
].join("\n");

const makeClient = (parent: HTMLElement, name: string, color: string, seed?: Y.Doc) => {
  const ydoc = new Y.Doc();
  if (seed) Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(seed));
  const ytext = ydoc.getText("codemirror");
  if (!seed) ytext.insert(0, doc);
  const awareness = new Awareness(ydoc);
  awareness.setLocalStateField("user", { name, color });
  // The note editor's rich-mode extensions, without the server-rendered query previews this note has no use for.
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: ytext.toString(),
      extensions: [
        yCollab(ytext, null, { undoManager: new Y.UndoManager(ytext) }),
        remoteCursors(ytext, awareness),
        editor.basicExtensions(),
        editor.markdownExtension(),
        editor.searchTheme(),
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
  return { ydoc, ytext, awareness, view };
};

const root = document.getElementById("root")!;
root.style.cssText = "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;";
const left = document.createElement("div");
const right = document.createElement("div");
left.id = "a";
right.id = "b";
root.append(left, right);
const a = makeClient(left, "Ada", "#7c3aed");
const b = makeClient(right, "Grace", "#059669", a.ydoc);

// Relay document and awareness updates between the two clients like the server does.
a.ydoc.on("update", (update: Uint8Array, origin: unknown) => origin !== "relay" && Y.applyUpdate(b.ydoc, update, "relay"));
b.ydoc.on("update", (update: Uint8Array, origin: unknown) => origin !== "relay" && Y.applyUpdate(a.ydoc, update, "relay"));
a.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
  if (origin === "relay") return;
  applyAwarenessUpdate(b.awareness, encodeAwarenessUpdate(a.awareness, [...added, ...updated, ...removed]), "relay");
});
b.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
  if (origin === "relay") return;
  applyAwarenessUpdate(a.awareness, encodeAwarenessUpdate(b.awareness, [...added, ...updated, ...removed]), "relay");
});

const views = { a: a.view, b: b.view };

// Links that would leave the page record where they lead instead.
const opened: string[] = [];
handleSoftNoteNavigationRequests(async (href) => {
  opened.push(href);
  return { kind: "applied", href };
});
window.open = (url) => {
  opened.push(String(url));
  return null;
};
type Side = keyof typeof views;

const find = (side: Side, text: string, offset = 0) => {
  const index = views[side].state.doc.toString().indexOf(text);
  if (index < 0) throw new Error(`"${text}" is not in the note.`);
  return index + offset;
};

const settle = async () => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

const harness = {
  views,
  opened,
  find,
  settle,
  held: (side: Side) => views[side].state.field(pointerSelectionHeld),
  coords: (side: Side, pos: number, assoc: -1 | 1 = 1) => {
    const coords = views[side].coordsAtPos(pos, assoc);
    if (!coords) throw new Error(`No coordinates at ${pos}`);
    return coords;
  },
  caretCoords: (side: Side, head: number, anchor = head) => {
    const view = views[side];
    const block = view.lineBlockAt(head);
    if (block.type === BlockType.WidgetRange) {
      const content = view.contentDOM.getBoundingClientRect();
      const line = view.contentDOM.querySelector(".cm-line")!;
      const style = getComputedStyle(line);
      return {
        left: content.left + parseFloat(getComputedStyle(view.contentDOM).paddingLeft) + parseFloat(style.paddingLeft),
        top: view.documentTop + block.top,
        height: view.defaultLineHeight,
      };
    }
    const coords = harness.coords(side, head, head > anchor ? -1 : 1);
    return { left: coords.left, top: coords.top, height: coords.bottom - coords.top };
  },
  selection: (side: Side) => {
    const { from, to, anchor, head } = views[side].state.selection.main;
    return { from, to, anchor, head, text: views[side].state.sliceDoc(from, to) };
  },
  select: (side: Side, anchor: number, head = anchor) => {
    views[side].focus();
    views[side].dispatch({ selection: EditorSelection.single(anchor, head) });
  },
  type: (side: Side, text: string) => {
    const view = views[side];
    view.dispatch(view.state.replaceSelection(text));
  },
  copy: (side: Side) => {
    const data = new DataTransfer();
    views[side].contentDOM.dispatchEvent(new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }));
    return data.getData("text/plain");
  },
  lineEdges: (side: Side) =>
    Array.from(views[side].contentDOM.querySelectorAll(".cm-line"), (line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      return range.getBoundingClientRect().left;
    }),
};

export type SelectionHarness = typeof harness;
declare global {
  interface Window {
    selectionHarness: SelectionHarness;
  }
}
window.selectionHarness = harness;
