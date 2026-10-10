import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { StateField } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";

const tabSize = 2;

class SpacerWidget extends WidgetType {
  override toDOM() {
    const spacer = document.createElement("span");
    spacer.className = "custom-list-indent";
    spacer.style.cssText = "width: 2rem; text-decoration: none; display: inline-flex;";

    const line = document.createElement("span");
    line.className = "custom-list-indent-marker";
    line.innerHTML = "&nbsp;";

    spacer.appendChild(line);
    return spacer;
  }

  override eq(other: WidgetType) {
    return other instanceof SpacerWidget;
  }
}

class DotWidget extends WidgetType {
  override toDOM() {
    const wrapper = document.createElement("label");
    wrapper.className = "custom-list-marker";
    wrapper.style.minWidth = "1rem";
    wrapper.setAttribute("aria-hidden", "true");
    wrapper.setAttribute("inert", "true");
    wrapper.innerHTML = "&bull;";
    return wrapper;
  }

  override eq(other: WidgetType) {
    return other instanceof DotWidget;
  }
}

class TaskWidget extends WidgetType {
  constructor(private checked: boolean) {
    super();
  }

  override toDOM() {
    const wrapper = document.createElement("label");
    wrapper.className = "custom-list-marker custom-list-task";
    wrapper.style.minWidth = "2rem";
    wrapper.setAttribute("aria-hidden", "true");

    const input = document.createElement("input");
    input.className = "custom-list-task-marker";
    input.type = "checkbox";
    input.checked = this.checked;
    input.style.transform = "translateY(1px)";
    input.setAttribute("aria-hidden", "true");
    input.setAttribute("tabindex", "-1");

    wrapper.appendChild(input);
    return wrapper;
  }

  override eq(other: WidgetType) {
    return other instanceof TaskWidget && other.checked === this.checked;
  }

  override ignoreEvent() {
    return false;
  }
}

const getListInfo = (state: EditorState, { from, to, type }: SyntaxNodeRef) => {
  if (type.name === "Blockquote") return false;
  if (type.name !== "ListMark") return;

  const line = state.doc.lineAt(from);
  const lineStart = line.from;
  const marker = state.sliceDoc(from, to);
  const markerStart = from;
  const markerEnd = to;
  const markerHasTrailingSpace = state.sliceDoc(markerEnd, markerEnd + 1) === " ";
  const indentation = markerStart - lineStart;

  if (!markerHasTrailingSpace) return;

  const indentLevel = Math.floor(indentation / tabSize);
  const spacerDecorations: Range<Decoration>[] = [];

  for (let i = 0; i < indentLevel; i++) {
    const from = lineStart + i * tabSize;
    const to = from + tabSize;
    spacerDecorations.push(Decoration.replace({ widget: new SpacerWidget() }).range(from, to));
  }

  return {
    indentLevel,
    lineStart,
    marker,
    markerEnd,
    markerStart,
    spacerDecorations,
  };
};

const bulletLists = (): Extension => {
  const decorate = (state: EditorState): [DecorationSet, DecorationSet] => {
    const atomicRanges: Range<Decoration>[] = [];
    const decorationRanges: Range<Decoration>[] = [];

    syntaxTree(state).iterate({
      enter: (node) => {
        const result = getListInfo(state, node);
        if (!result) return;

        const { indentLevel, lineStart, marker, markerEnd, markerStart, spacerDecorations } = result;
        if (!["-", "*"].includes(marker)) return;

        const lineDec = Decoration.line({
          attributes: {
            class: "custom-list custom-list-bullet",
            style: `--indent-level: ${indentLevel}`,
          },
        }).range(lineStart);

        decorationRanges.push(lineDec);
        decorationRanges.push(...spacerDecorations);
        atomicRanges.push(...spacerDecorations);

        const textStart = markerEnd + 1;
        const dotDec = Decoration.replace({ widget: new DotWidget() }).range(markerStart, textStart);

        decorationRanges.push(dotDec);
        atomicRanges.push(dotDec);
      },
    });

    return [Decoration.set(decorationRanges, true), Decoration.set(atomicRanges, true)];
  };

  return StateField.define<[DecorationSet, DecorationSet]>({
    create(state) {
      return decorate(state);
    },
    update(value, tr) {
      // List decorations are purely positional (line classes + dot
      // widgets); they have no cursor dependency. Skip the rescan
      // when nothing structural about the doc changed. This was a
      // major lag source: the original code ran `decorate(state)`
      // on EVERY transaction including bare selection moves and
      // focus events, walking the syntax tree each time. The parser
      // reaches the rest of a long note after it opened, so a newer
      // syntax tree rescans too; otherwise those lists stay raw.
      if (!tr.docChanged && syntaxTree(tr.state) === syntaxTree(tr.startState)) {
        return [value[0].map(tr.changes), value[1].map(tr.changes)];
      }
      return decorate(tr.state);
    },
    provide(field) {
      return [
        EditorView.decorations.of((view) => view.state.field(field)[0]),
        EditorView.atomicRanges.of((view) => view.state.field(field)[1]),
      ];
    },
  });
};

const taskLists = (): Extension => {
  const decorate = (state: EditorState): [DecorationSet, DecorationSet] => {
    const atomicRanges: Range<Decoration>[] = [];
    const decorationRanges: Range<Decoration>[] = [];

    syntaxTree(state).iterate({
      enter: (node) => {
        const result = getListInfo(state, node);
        if (!result) return;

        const { indentLevel, lineStart, marker, markerEnd, markerStart, spacerDecorations } = result;
        if (!["-", "*"].includes(marker)) return;

        const taskStart = markerEnd + 1;
        const taskEnd = taskStart + 3;
        const task = state.sliceDoc(taskStart, taskEnd);

        if (!["[ ]", "[x]"].includes(task)) return;

        const textStart = taskEnd + 1;
        const taskHasTrailingSpace = state.sliceDoc(taskEnd, textStart) === " ";
        if (!taskHasTrailingSpace) return;

        const isChecked = task === "[x]";

        const lineDec = Decoration.line({
          attributes: {
            class: `custom-list custom-list-task ${isChecked ? "custom-list-task-checked" : "custom-list-task-unchecked"}`,
            style: `--indent-level: ${indentLevel}`,
          },
        }).range(lineStart);

        decorationRanges.push(lineDec);
        decorationRanges.push(...spacerDecorations);
        atomicRanges.push(...spacerDecorations);

        const taskDec = Decoration.replace({
          widget: new TaskWidget(isChecked),
        }).range(markerStart, taskEnd + 1);
        decorationRanges.push(taskDec);
        atomicRanges.push(taskDec);
      },
    });

    return [Decoration.set(decorationRanges, true), Decoration.set(atomicRanges, true)];
  };

  const viewPlugin = ViewPlugin.define(() => ({}), {
    eventHandlers: {
      mousedown: (event, view) => {
        const target = event.target as HTMLElement;
        const taskMarker = target.closest(".custom-list-task-marker") as HTMLInputElement;

        if (taskMarker?.type === "checkbox") {
          const position = view.posAtDOM(taskMarker);
          const line = view.state.doc.lineAt(position);
          const lineText = line.text;
          const markerOffset = Math.max(0, position - line.from);
          const taskMatch = /^\[[ x]\]/.exec(lineText.slice(markerOffset)) ?? lineText.match(/^\s*(?:[-*+]|\d+\.)\s+(\[[ x]\])/);
          if (taskMatch && taskMatch.index != null) {
            const from = line.from + (taskMatch[1] ? taskMatch[0].indexOf(taskMatch[1]) : markerOffset + taskMatch.index);
            const to = from + 3;
            const before = view.state.sliceDoc(from, to);
            const newText = before === "[ ]" ? "[x]" : "[ ]";
            view.dispatch({ changes: { from, to, insert: newText } });
          }
          return true;
        }
      },
    },
  });

  const stateField = StateField.define<[DecorationSet, DecorationSet]>({
    create(state) {
      return decorate(state);
    },
    update(value, tr) {
      // Same as bullet-list field above: task-list decorations are
      // pure layout (checkbox widget + line class), not cursor-
      // dependent. Only rebuild on doc changes and parser progress.
      if (!tr.docChanged && syntaxTree(tr.state) === syntaxTree(tr.startState)) {
        return [value[0].map(tr.changes), value[1].map(tr.changes)];
      }
      return decorate(tr.state);
    },
    provide(field) {
      return [
        EditorView.decorations.of((view) => view.state.field(field)[0]),
        EditorView.atomicRanges.of((view) => view.state.field(field)[1]),
      ];
    },
  });

  return [viewPlugin, stateField];
};

const listTheme = EditorView.theme({
  ".custom-list-indent": {
    display: "inline-flex",
    justifyContent: "center",
  },
  ".custom-list-indent-marker": {
    borderLeft: "1px solid rgba(107, 114, 128, 0.2)",
    bottom: "0",
    overflow: "hidden",
    position: "absolute",
    top: "0",
    width: "0",
  },
  ".custom-list": {
    paddingLeft: "calc(var(--indent-level) * 2rem + 2rem) !important",
    position: "relative",
    textIndent: "calc((var(--indent-level) * 2rem + 2rem) * -1)",
  },
  ".custom-list *": {
    textIndent: "0",
  },
  ".custom-list-marker": {
    alignItems: "center",
    color: "var(--color-gray-500)",
    display: "inline-flex",
    justifyContent: "center",
    minWidth: "2rem",
    fontWeight: "bold",
  },
  ".custom-list-task-marker": {
    scale: "1",
    transformOrigin: "center center",
  },
  ".custom-list-task-checked": {
    textDecoration: "line-through",
    textDecorationColor: "var(--color-gray-500)",
    opacity: "0.7",
  },
});

export const listsExtension = (): Extension => {
  return [taskLists(), bulletLists(), listTheme];
};
