/**
 * Formatted view: Markdown markers hide outside the element you are editing.
 * The document never changes; only decorations do. Headings, bold, italic,
 * strikethrough, inline code, links, quotes, lists, code blocks and `---`.
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

class BulletWidget extends WidgetType {
  override toDOM() {
    const el = document.createElement("span");
    el.className = "k2b-ste-bullet";
    el.textContent = "•";
    return el;
  }
  override eq() {
    return true;
  }
}

class RuleWidget extends WidgetType {
  override toDOM() {
    const el = document.createElement("span");
    el.className = "k2b-ste-hr";
    return el;
  }
  override eq() {
    return true;
  }
}

const hide = Decoration.replace({});
const lineClass = (cls: string) => Decoration.line({ class: cls });
const mark = (cls: string) => Decoration.mark({ class: cls });

// Without focus nothing is "being edited": the whole text shows formatted.

const touches = (state: EditorState, from: number, to: number, focused: boolean) =>
  focused && state.selection.ranges.some((r) => r.from <= to && r.to >= from);
const onLine = (state: EditorState, from: number, to: number, focused: boolean) => {
  if (!focused) return false;
  const a = state.doc.lineAt(from).number;
  const b = state.doc.lineAt(to).number;
  return state.selection.ranges.some((r) => state.doc.lineAt(r.from).number <= b && state.doc.lineAt(r.to).number >= a);
};

const build = (view: EditorView): DecorationSet => {
  const { state } = view;
  const focused = view.hasFocus;
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;
        if (name === "Table") return false; // owned by the table grid
        if (name === "FencedCode" || name === "CodeBlock") {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            out.push(lineClass("k2b-ste-codeblock").range(line.from));
            pos = line.to + 1;
          }
          if (name === "FencedCode" && !touches(state, node.from, node.to, focused)) {
            for (const marker of node.node.getChildren("CodeMark")) out.push(hide.range(marker.from, marker.to));
            const info = node.node.getChild("CodeInfo");
            if (info) out.push(hide.range(info.from, info.to));
          }
          return false;
        }
        const heading = /^ATXHeading(\d)$/.exec(name);
        if (heading) {
          const line = state.doc.lineAt(node.from);
          out.push(lineClass(`k2b-ste-h k2b-ste-h${heading[1]}`).range(line.from));
          if (!onLine(state, node.from, node.to, focused)) {
            const markNode = node.node.getChild("HeaderMark");
            if (markNode) {
              const end = state.doc.sliceString(markNode.to, markNode.to + 1) === " " ? markNode.to + 1 : markNode.to;
              out.push(hide.range(markNode.from, end));
            }
          }
          return;
        }
        if (name === "Blockquote") {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            out.push(lineClass("k2b-ste-quote").range(line.from));
            pos = line.to + 1;
          }
          return;
        }
        if (name === "QuoteMark") {
          if (!onLine(state, node.from, node.to, focused)) {
            const end = state.doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
            out.push(hide.range(node.from, end));
          }
          return;
        }
        if (name === "HorizontalRule") {
          if (!onLine(state, node.from, node.to, focused))
            out.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to));
          return;
        }
        if (name === "ListMark") {
          const bullet = /^[-*+]$/.test(state.sliceDoc(node.from, node.to));
          if (bullet && !onLine(state, node.from, node.to, focused))
            out.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to));
          else out.push(mark("k2b-ste-listmark").range(node.from, node.to));
          return;
        }
        const inline: Record<string, [string, string]> = {
          StrongEmphasis: ["k2b-ste-strong", "EmphasisMark"],
          Emphasis: ["k2b-ste-em", "EmphasisMark"],
          Strikethrough: ["k2b-ste-strike", "StrikethroughMark"],
          InlineCode: ["k2b-ste-code", "CodeMark"],
        };
        const spec = inline[name];
        if (spec) {
          if (node.to > node.from) out.push(mark(spec[0]).range(node.from, node.to));
          if (!touches(state, node.from, node.to, focused)) {
            const cursor = node.node.cursor();
            if (cursor.firstChild())
              do {
                if (cursor.name === spec[1] && cursor.to > cursor.from) out.push(hide.range(cursor.from, cursor.to));
              } while (cursor.nextSibling());
          }
          return name === "InlineCode" ? false : undefined;
        }
        if (name === "Link") {
          const marks = node.node.getChildren("LinkMark");
          const url = node.node.getChild("URL");
          if (marks.length >= 2) {
            out.push(mark("k2b-ste-link").range(marks[0]!.to, marks[1]!.from));
            if (!touches(state, node.from, node.to, focused)) {
              out.push(hide.range(marks[0]!.from, marks[0]!.to));
              out.push(hide.range(marks[1]!.from, node.to));
            } else if (url) out.push(mark("k2b-ste-url").range(url.from, url.to));
          }
          return false;
        }
        return;
      },
    });
  }
  return Decoration.set(out, true);
};

export const formattedView = [
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.focusChanged ||
          update.viewportChanged ||
          syntaxTree(update.startState) !== syntaxTree(update.state)
        )
          this.decorations = build(update.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
  EditorView.contentAttributes.of({ class: "k2b-ste-formatted" }),
];
