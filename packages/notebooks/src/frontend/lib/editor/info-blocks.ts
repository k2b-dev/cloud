import type { EditorState, Extension, Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { NOTICE_CARD_CLASSES, type NoticeTone } from "@k2b/ui";
import { bookRendererMessages } from "../../../lib/book-renderer-messages";
import { literalMarkdownLines, notebookDirectiveLength } from "../../../lib/markdown-context";
import { closesNotice } from "../../../lib/markdown-fences";
import {
  blockWidgetLineNavigationExtension,
  type CursorZoneState,
  cursorZoneStateField,
  selectionIntersectsRange,
} from "./_lib/cursor-zone-field";
import { applyLigatures } from "./ligatures";

type BlockType = "note" | "info" | "success" | "warning" | "danger";

type InfoBlockData = {
  type: BlockType;
  content: string;
};

const blockTones = {
  note: "neutral",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
} as const satisfies Record<BlockType, NoticeTone>;

const isBlockType = (value: string): value is BlockType => Object.hasOwn(blockTones, value);

const escapeHtml = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const renderContent = (content: string): string => {
  const codeSpans: string[] = [];
  return escapeHtml(content)
    .replace(/`([^`]+)`/g, (_match, body: string) => {
      const index = codeSpans.push(`<code class="bg-black/10 dark:bg-white/10 px-1 py-0.5 rounded text-sm">${body}</code>`) - 1;
      return `\u0000CODE${index}\u0000`;
    })
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\n/g, "<br>")
    .replace(/\u0000CODE(\d+)\u0000/g, (_match, index: string) => codeSpans[Number(index)] ?? "");
};

class InfoBlockWidget extends WidgetType {
  constructor(
    private blockData: InfoBlockData,
    private fromPos: number,
    private label: string,
  ) {
    super();
  }

  override toDOM(view: EditorView) {
    const container = document.createElement("div");
    container.className = "cm-notice-card-widget cursor-pointer";
    container.setAttribute("contenteditable", "false");
    container.setAttribute("tabindex", "0");
    container.onmousedown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.fromPos }, scrollIntoView: true });
      view.focus();
    };
    container.ondblclick = (event) => {
      event.stopPropagation();
    };

    // Tone colour only; the type name remains for screen readers.
    const block = document.createElement("div");
    block.className = NOTICE_CARD_CLASSES.root;
    block.dataset.tone = blockTones[this.blockData.type];
    block.setAttribute("role", "note");

    const label = document.createElement("span");
    label.className = "sr-only";
    label.textContent = `${this.label}: `;

    const contentDiv = document.createElement("div");
    contentDiv.className = NOTICE_CARD_CLASSES.body;
    contentDiv.innerHTML = renderContent(this.blockData.content);
    applyLigatures(contentDiv);

    block.appendChild(label);
    block.appendChild(contentDiv);
    container.appendChild(block);
    return container;
  }

  override eq(other: WidgetType) {
    return (
      other instanceof InfoBlockWidget &&
      other.fromPos === this.fromPos &&
      other.label === this.label &&
      other.blockData.type === this.blockData.type &&
      other.blockData.content === this.blockData.content
    );
  }

  override ignoreEvent() {
    return true;
  }

  override get estimatedHeight() {
    // One 20px body line per source line plus the card's padding and border.
    const lines = this.blockData.content.split("\n").length;
    return lines * 20 + 26;
  }
}

const NOTICE_OPENER = /^ {0,3}:::(\w+)[ \t]*$/;

/** Finds notices with the same block scanner as the book view, so every
 *  directive ends at its own `:::` and code or list content stays source. */
const findInfoBlocks = (state: EditorState, labels: Record<BlockType, string>): CursorZoneState => {
  const decorations: Range<Decoration>[] = [];
  const ranges: { from: number; to: number }[] = [];
  const cursor = state.selection.main;
  const text = state.doc.toString();
  if (!text.includes(":::")) return { decorations: Decoration.none, atomicDecorations: Decoration.none, ranges };
  const literal = literalMarkdownLines(text);

  for (let number = 1; number <= state.doc.lines; number++) {
    const opener = state.doc.line(number);
    const type = NOTICE_OPENER.exec(opener.text)?.[1];
    if (!type || !isBlockType(type) || literal.has(number - 1)) continue;
    const blockLines = text
      .slice(opener.from, opener.from + (notebookDirectiveLength(text.slice(opener.from)) ?? 0))
      .replace(/\n$/, "")
      .split("\n");
    if (blockLines.length < 2 || !closesNotice(blockLines.at(-1)!, opener.text)) continue;
    const blockStart = opener.from;
    const blockEnd = state.doc.line(number + blockLines.length - 1).to;
    const sourceVisibleStart = state.doc.lineAt(Math.max(blockStart - 1, 0)).from;
    const sourceVisibleEnd = state.doc.lineAt(Math.min(blockEnd + 1, state.doc.length)).to;
    ranges.push({ from: sourceVisibleStart, to: sourceVisibleEnd });

    // Cursor is inside the block → don't render the widget so the user
    // can edit the raw `:::xxx` markers.
    if (selectionIntersectsRange(cursor, sourceVisibleStart, sourceVisibleEnd)) continue;

    const blockData = { type, content: blockLines.slice(1, -1).join("\n").trim() };
    decorations.push(
      Decoration.replace({
        widget: new InfoBlockWidget(blockData, blockStart, labels[type]),
        block: true,
      }).range(blockStart, blockEnd),
    );
  }

  const set = decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none;
  return { decorations: set, atomicDecorations: set, ranges };
};

/** `locale` names each notice type for screen readers; the rendered block shows only its tone colour. */
export const infoBlocksExtension = (locale: string): Extension => {
  const { t } = bookRendererMessages.resolve([locale]);
  const labels = { note: t.note, info: t.info, success: t.success, warning: t.warning, danger: t.danger };
  // Container context anywhere above a notice decides whether it renders, so
  // every document change rescans, like the query and table-of-contents blocks.
  const stateField = cursorZoneStateField((state) => findInfoBlocks(state, labels));

  const theme = EditorView.theme({
    ".cm-notice-card-widget": {
      display: "block",
      margin: "0 !important",
      lineHeight: "1",
    },
  });

  return [stateField, blockWidgetLineNavigationExtension(stateField, (value) => value.atomicDecorations), theme];
};
