/**
 * Clean paste: HTML from Word, Google Docs or web pages becomes the editor's
 * small Markdown set. Styles, classes, fonts, colours and images are dropped.
 * Tab-separated text (Excel, Sheets, Numbers) becomes a table.
 */
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { convertClipboardHtml, inspectClipboard } from "./clipboard";
import { tableFromGrid } from "./markdown-table";
import { tableHost } from "./table";

const inCode = (state: EditorState): boolean => {
  const { from, to } = state.selection.main;
  const lineEnd = state.doc.lineAt(from).to;
  const tree = ensureSyntaxTree(state, Math.max(to, lineEnd)) ?? syntaxTree(state);
  for (const pos of [from, lineEnd]) {
    for (let node: typeof tree.topNode | null = tree.resolve(pos, -1); node; node = node.parent) {
      if (to > node.to) continue;
      if (node.name === "CodeBlock") return true;
      // An indented block's first node starts after its leading indentation.
      // Only that block may be inferred from the rest of the current line.
      if (pos !== from) continue;
      if (node.name === "InlineCode") {
        const marks = node.getChildren("CodeMark");
        const first = marks[0];
        const last = marks[marks.length - 1];
        if (first && last && from >= first.to && to <= last.from) return true;
      }
      if (node.name === "FencedCode") {
        const marks = node.getChildren("CodeMark");
        const first = marks[0];
        const last = marks[marks.length - 1];
        if (!first || !last) continue;
        const start = state.doc.lineAt(first.to).to + 1;
        const end = marks.length > 1 ? state.doc.lineAt(last.from).from : node.to;
        if (from >= start && to <= end) return true;
      }
    }
  }
  return false;
};

/** HTML clipboard content as Markdown; `null` when it is better pasted as plain text. */
export const htmlToMarkdown = (html: string): { markdown: string; droppedImages: number } | null => convertClipboardHtml(html, false);

export const cleanPaste = (onDroppedImages?: (count: number, files: File[]) => void, plain = false) =>
  EditorView.domEventHandlers({
    paste(event, view) {
      if (view.state.readOnly) return false;
      const data = event.clipboardData;
      if (!data) return false;
      const host = view.state.facet(tableHost);
      const clipboard = inspectClipboard(data, {
        maxLength: host?.maxLength ?? Infinity,
        maxPasteCells: plain ? Infinity : (host?.maxPasteCells ?? 2000),
      });
      if ("error" in clipboard) {
        event.preventDefault();
        host?.onError(clipboard.error);
        return true;
      }
      const { html, text, tsv: grid, images, files } = clipboard;
      if (images) onDroppedImages?.(images, files);
      if (plain) {
        if (images && !text) {
          event.preventDefault();
          return true;
        }
        return false;
      }
      const code = inCode(view.state);
      if (code && text) return false;
      let insert: string | null = null;
      if (html) {
        const converted = convertClipboardHtml(html, code);
        if (converted) {
          insert = converted.markdown;
        }
      }
      if (insert === null && grid?.length) insert = tableFromGrid(grid);
      if (insert === null) {
        if (images && !text) {
          event.preventDefault();
          return true;
        }
        return false;
      }
      event.preventDefault();
      const block = !code && insert.includes("\n") && /^(\||#|>|- |\d+\. |```)/m.test(insert);
      const { from, to } = view.state.selection.main;
      if (block) {
        // A block never glues onto the text around it: a table row must not swallow the next paragraph.
        const doc = view.state.doc;
        const before = doc.sliceString(Math.max(0, from - 2), from);
        const after = doc.sliceString(to, Math.min(doc.length, to + 2));
        const lead = from === 0 || before === "\n\n" ? "" : before.endsWith("\n") ? "\n" : "\n\n";
        const trail = to === doc.length || after === "\n\n" ? "" : after.startsWith("\n") ? "\n" : "\n\n";
        insert = `${lead}${insert}${trail}`;
      }
      view.dispatch(view.state.replaceSelection(insert), { userEvent: "input.paste" });
      return true;
    },
  });
