import { EditorState, type Range, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { noteScroller } from "./note-scroller";

// The smallest note page that reproduces the WebKit jump: a page scroller under
// a size container, CodeMirror inside it, and a block widget that parses an SVG
// `viewBox` while CodeMirror builds the lines it scrolled to, as the notice icon does.

class IconWidget extends WidgetType {
  override eq() {
    return true;
  }

  override toDOM() {
    const element = document.createElement("div");
    element.style.height = "60px";
    // Parsed from markup like the notice card's icon; WebKit lays the page out while it parses the viewBox.
    element.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20"></svg>';
    return element;
  }

  override get estimatedHeight() {
    return 60;
  }
}

const icons = (state: EditorState): DecorationSet => {
  const ranges: Range<Decoration>[] = [];
  for (const match of state.doc.toString().matchAll(/^:::icon$/gm))
    ranges.push(Decoration.replace({ widget: new IconWidget(), block: true }).range(match.index, match.index + match[0].length));
  return Decoration.set(ranges);
};

const iconField = StateField.define<DecorationSet>({
  create: icons,
  update: (value, tr) => (tr.docChanged ? icons(tr.state) : value),
  provide: (field) => EditorView.decorations.from(field),
});

const doc = Array.from({ length: 6 }, (_, block) =>
  [
    ...Array.from({ length: 35 }, (_, line) => `Paragraph ${block + 1}.${line + 1}`),
    ":::icon",
    `Anchor ${block + 1}`,
    ...Array.from({ length: 35 }, (_, line) => `Following ${block + 1}.${line + 1}`),
  ].join("\n\n"),
).join("\n\n");

const port = document.getElementById("port")!;
const view = new EditorView({
  parent: port,
  state: EditorState.create({ doc, extensions: [iconField, noteScroller, EditorView.theme({ ".cm-line": { lineHeight: "20px" } })] }),
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const harness = {
  settle: async () => {
    for (let index = 0; index < 5; index++) await frame();
  },
  /** Scrolls the page so the line sits in the middle, then reports where the page scroller ends up. */
  scrollTo: async (text: string) => {
    const from = view.state.doc.toString().indexOf(text);
    const top = view.documentTop + view.lineBlockAt(from).top - port.getBoundingClientRect().top;
    const target = port.scrollTop + top - port.clientHeight / 2;
    port.scrollTop = target;
    const written = port.scrollTop;
    for (let index = 0; index < 4; index++) await frame();
    return { written, scrollTop: port.scrollTop };
  },
  /** Deletes the start of the note while the focused editor sits at the bottom, as a collaborator's edit arrives. */
  deleteAboveAtBottom: async (length: number) => {
    view.focus();
    port.scrollTop = port.scrollHeight;
    for (let index = 0; index < 4; index++) await frame();
    const before = port.scrollHeight - port.clientHeight - port.scrollTop;
    view.dispatch({ changes: { from: 0, to: length } });
    for (let index = 0; index < 4; index++) await frame();
    return { before, after: port.scrollHeight - port.clientHeight - port.scrollTop };
  },
};

export type NoteScrollerHarness = typeof harness;
Object.assign(window, { harness });
