import type { EditorState, Extension, Range, Transaction } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { NOTICE_CARD_CLASSES, type NoticeTone } from "@k2b/ui";
import { bookRendererMessages } from "../../../lib/book-renderer-messages";
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

const parseInfoBlock = (text: string): InfoBlockData | null => {
  const match = text.match(/^:::(\w+)\s*\n([\s\S]*?)\n:::$/);
  if (!match) return null;

  const typeStr = match[1];
  const content = match[2];
  if (!typeStr || content == null) return null;
  const type = typeStr.toLowerCase() as BlockType;
  if (!blockTones[type]) return null;

  return { type, content: content.trim() };
};

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

const BLOCK_REGEX = /^:::(\w+)\s*\n([\s\S]*?)\n:::$/gm;

/** Source-byte ranges of every `:::TYPE…:::` block drive the
 *  cursor-zone rebuild gate — cursor moves through plain prose
 *  skip the full doc.toString() + matchAll() rescan because the
 *  key (= which block contains the cursor) doesn't change. Doc
 *  changes are gated by `changesMightAffectBlocks` below — typing
 *  in prose without any `:` skips the rescan entirely. */
const findInfoBlocks = (state: EditorState, labels: Record<BlockType, string>): CursorZoneState => {
  const decorations: Range<Decoration>[] = [];
  const atomicDecorations: Range<Decoration>[] = [];
  const ranges: { from: number; to: number }[] = [];
  const cursor = state.selection.main;
  const text = state.doc.toString();
  let hasSyntax = false;

  // `matchAll` yields an iterator that auto-advances per loop step, so a
  // `continue` (used to skip rendering when the cursor sits inside a block)
  // doesn't pin the regex on the same match — which is what an inline
  // `regex.exec` loop would do, and exactly what produced the editor
  // freeze when typing `/info` `/success` etc. via slash commands.
  for (const match of text.matchAll(BLOCK_REGEX)) {
    if (match.index === undefined) continue;
    const blockStart = match.index;
    const blockEnd = blockStart + match[0].length;
    const prevLine = state.doc.lineAt(Math.max(blockStart - 1, 0));
    const nextLine = state.doc.lineAt(Math.min(blockEnd + 1, state.doc.length));
    const sourceVisibleEnd = nextLine.to;
    const sourceVisibleStart = prevLine.from;
    hasSyntax = true;
    ranges.push({ from: sourceVisibleStart, to: sourceVisibleEnd });

    // Cursor is inside the block → don't render the widget so the user
    // can edit the raw `:::xxx` markers.
    if (selectionIntersectsRange(cursor, sourceVisibleStart, sourceVisibleEnd)) continue;

    const blockData = parseInfoBlock(match[0]);
    if (!blockData) continue;
    const blockDecoration = Decoration.replace({
      widget: new InfoBlockWidget(blockData, blockStart, labels[blockData.type]),
      block: true,
    }).range(blockStart, blockEnd);
    decorations.push(blockDecoration);
    atomicDecorations.push(blockDecoration);
  }

  return {
    decorations: decorations.length > 0 ? RangeSet.of(decorations, true) : Decoration.none,
    atomicDecorations: atomicDecorations.length > 0 ? RangeSet.of(atomicDecorations, true) : Decoration.none,
    ranges,
    hasSyntax,
  };
};

/** Predicate for the incremental cursor-zone mode. The block
 *  fence is `:::` so any change involving `:` is suspect. False
 *  positives (typing `:` in a URL, time, dict literal) fall back
 *  to baseline (full rescan); false negatives would leave stale
 *  widgets, so the predicate is intentionally generous. */
const changesMightAffectBlocks = (tr: Transaction): boolean => {
  let might = false;
  tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
    if (might) return;
    if (inserted.toString().includes(":")) {
      might = true;
      return;
    }
    const from = Math.max(0, fromB - 2);
    const to = Math.min(tr.state.doc.length, toB + 2);
    might = tr.state.doc.sliceString(from, to).includes(":");
  });
  return might;
};

/** `locale` names each notice type for screen readers; the rendered block shows only its tone colour. */
export const infoBlocksExtension = (locale: string): Extension => {
  const { t } = bookRendererMessages.resolve([locale]);
  const labels = { note: t.note, info: t.info, success: t.success, warning: t.warning, danger: t.danger };
  const stateField = cursorZoneStateField((state) => findInfoBlocks(state, labels), {
    changesMightAffectSyntax: changesMightAffectBlocks,
  });

  const theme = EditorView.theme({
    ".cm-notice-card-widget": {
      display: "block",
      margin: "0 !important",
      lineHeight: "1",
    },
  });

  return [stateField, blockWidgetLineNavigationExtension(stateField, (value) => value.atomicDecorations), theme];
};
