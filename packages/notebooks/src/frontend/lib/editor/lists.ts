import type { EditorState, Extension, Range } from "@codemirror/state";
import { StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { treeOrDocChanged } from "./_lib/cursor-zone-field";
import { type ListItem, type ListItemKind, type ListStructure, listItemAtLine, listStructure, orderedLabel } from "./_lib/list-structure";

class ListGutterWidget extends WidgetType {
  constructor(
    private readonly depth: number,
    private readonly kind: ListItemKind,
    private readonly label: string,
    private readonly checked: boolean,
  ) {
    super();
  }

  override eq(other: WidgetType) {
    return (
      other instanceof ListGutterWidget &&
      this.depth === other.depth &&
      this.kind === other.kind &&
      this.label === other.label &&
      this.checked === other.checked
    );
  }

  override toDOM() {
    const gutter = document.createElement("span");
    gutter.className = "custom-list-gutter";
    gutter.setAttribute("aria-hidden", "true");
    for (let level = 0; level < this.depth; level++) {
      const guide = document.createElement("span");
      guide.className = "custom-list-guide";
      guide.style.setProperty("--list-level", String(level));
      gutter.append(guide);
    }
    const marker = document.createElement("span");
    marker.className = `custom-list-marker custom-list-marker-${this.kind}`;
    if (this.kind === "task") {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "custom-list-task-marker";
      input.tabIndex = -1;
      input.setAttribute("aria-hidden", "true");
      input.checked = this.checked;
      marker.append(input);
    } else if (this.kind === "ordered") marker.textContent = this.label;
    else {
      const dot = document.createElement("span");
      dot.className = `custom-list-dot custom-list-dot-${this.depth % 3}`;
      marker.append(dot);
    }
    gutter.append(marker);
    return gutter;
  }

  override ignoreEvent(event: Event) {
    return this.kind === "task" ? false : super.ignoreEvent(event);
  }
}

const decorated = (state: EditorState, item: ListItem): boolean =>
  item.taskTo !== null
    ? state.sliceDoc(item.taskTo, item.taskTo + 1) === " "
    : /[ \t]/.test(state.sliceDoc(item.markerTo, item.markerTo + 1));

const selectionParent = (state: EditorState, structure: ListStructure): number => {
  const index = listItemAtLine(structure, state.doc.lineAt(state.selection.main.head).number);
  return structure.items[index]?.parent ?? -1;
};

const activeGuides = (state: EditorState, structure: ListStructure, parent: number): DecorationSet => {
  const item = structure.items[parent];
  if (!item) return Decoration.none;
  const ranges: Range<Decoration>[] = [];
  const decoration = Decoration.line({ attributes: { style: `--list-active-level: ${item.depth}` } });
  for (let index = parent + 1; index < item.subtreeEnd; index++) {
    const child = structure.items[index]!;
    if (decorated(state, child)) ranges.push(decoration.range(child.from));
  }
  return Decoration.set(ranges, true);
};

type ListState = {
  structure: ListStructure;
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
  active: DecorationSet;
  parent: number;
};

const build = (state: EditorState): ListState => {
  const structure = listStructure(state);
  const ranges: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  for (const item of structure.items) {
    if (!decorated(state, item)) continue;
    ranges.push(
      Decoration.line({
        attributes: {
          class: `custom-list custom-list-${item.kind}${item.checked ? " custom-list-task-checked" : ""}`,
          style: `--list-depth: ${item.depth}`,
        },
      }).range(item.from),
    );
    const label = item.ordinal === null ? "" : orderedLabel(item.ordinal, item.orderedDepth);
    const gutter = Decoration.replace({ widget: new ListGutterWidget(item.depth, item.kind, label, item.checked) }).range(
      item.from,
      item.contentFrom,
    );
    ranges.push(gutter);
    atomic.push(gutter);
  }
  const parent = selectionParent(state, structure);
  return {
    structure,
    decorations: Decoration.set(ranges, true),
    atomicRanges: Decoration.set(atomic, true),
    active: activeGuides(state, structure, parent),
    parent,
  };
};

export const listStateField = StateField.define<ListState>({
  create: build,
  update(value, tr) {
    // Selection-only transactions must not walk the tree. Rescan a newer tree too:
    // the parser reaches lists near the end of a long note after it opened.
    if (treeOrDocChanged(tr)) return build(tr.state);
    const parent = selectionParent(tr.state, value.structure);
    return {
      ...value,
      decorations: value.decorations.map(tr.changes),
      atomicRanges: value.atomicRanges.map(tr.changes),
      active: parent === value.parent ? value.active.map(tr.changes) : activeGuides(tr.state, value.structure, parent),
      parent,
    };
  },
  provide(field) {
    return [
      EditorView.decorations.from(field, (value) => value.decorations),
      EditorView.decorations.from(field, (value) => value.active),
      EditorView.atomicRanges.of((view) => view.state.field(field).atomicRanges),
    ];
  },
});

const taskPress = ViewPlugin.define(() => ({}), {
  eventHandlers: {
    mousedown(event, view) {
      if (!(event.target instanceof Element)) return;
      const checkbox = event.target.closest(".custom-list-task-marker");
      if (!checkbox || checkbox.getAttribute("type") !== "checkbox") return;
      const line = view.state.doc.lineAt(view.posAtDOM(checkbox));
      const structure = view.state.field(listStateField).structure;
      const item = structure.items[listItemAtLine(structure, line.number)];
      if (item && item.taskFrom !== null && item.taskTo !== null) {
        view.dispatch({ changes: { from: item.taskFrom, to: item.taskTo, insert: item.checked ? "[ ]" : "[x]" } });
      }
      return true;
    },
  },
});

const listTheme = EditorView.theme({
  ".custom-list": {
    "--list-step": "1.625rem",
    position: "relative",
    paddingLeft: "calc(var(--list-step) * (var(--list-depth) + 1)) !important",
    textIndent: "calc(var(--list-step) * (var(--list-depth) + 1) * -1)",
  },
  "@media (max-width: 640px)": { ".custom-list": { "--list-step": "1.375rem" } },
  ".custom-list *": { textIndent: "0" },
  ".custom-list-gutter": {
    display: "inline-flex",
    justifyContent: "flex-end",
    verticalAlign: "top",
    height: "1lh",
    width: "calc(var(--list-step) * (var(--list-depth) + 1))",
    userSelect: "none",
  },
  ".custom-list-guide": {
    position: "absolute",
    top: "0",
    bottom: "0",
    width: "1px",
    left: "calc(var(--list-step) * var(--list-level) + var(--list-step) / 2 - 0.5px)",
    background: "var(--k2b-text, currentColor)",
    pointerEvents: "none",
    opacity:
      "calc(0.14 + 0.24 * clamp(0, 1 - (var(--list-level) - var(--list-active-level, -9)) * (var(--list-level) - var(--list-active-level, -9)), 1))",
  },
  ".custom-list-marker": {
    flex: "none",
    boxSizing: "border-box",
    width: "var(--list-step)",
    height: "1lh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--k2b-text-muted)",
  },
  ".custom-list-marker-ordered": {
    justifyContent: "flex-end",
    paddingRight: "0.375rem",
    fontVariantNumeric: "tabular-nums",
    color: "var(--k2b-text-secondary)",
    whiteSpace: "nowrap",
  },
  ".custom-list-dot": { boxSizing: "border-box", width: "0.375rem", height: "0.375rem", borderRadius: "50%", background: "currentColor" },
  ".custom-list-dot-1": { width: "0.4rem", height: "0.4rem", background: "none", border: "1.5px solid currentColor" },
  ".custom-list-dot-2": { width: "0.35rem", height: "0.35rem", borderRadius: "1px" },
  ".custom-list-task-marker": { width: "1rem", height: "1rem", margin: "0", accentColor: "var(--k2b-action-solid)" },
  ".custom-list-task-checked": {
    color: "var(--k2b-text-muted)",
    textDecoration: "line-through",
    textDecorationColor: "var(--k2b-placeholder-color)",
  },
});

export const listsExtension = (): Extension => [listStateField, taskPress, listTheme];
