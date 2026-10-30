import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { formatShortcut, keyboardPlatform } from "@k2b/ui";
import { textEditorCommands } from "@k2b/ui/text-editor";
import type { EditorAction } from "./editor";
import { editorMessages } from "./messages";

/** Apple keyboards name the platform modifier Command; everyone else uses Control. */
export const isApple = () => keyboardPlatform() === "apple";

/** A CodeMirror key spec such as `Mod-Shift-z`, written with the shared key names (`⇧⌘Z`, `Ctrl+Shift+Z`). */
export const shortcutLabel = (keys: string, locale?: string) => {
  const minus = keys === "-" || keys.endsWith("--");
  const parts = (minus ? keys.slice(0, -1) : keys).split("-");
  if (minus) parts.pop();
  const key = minus ? "-" : parts.pop();
  return formatShortcut([...parts, key ?? ""].join("+"), { locale }).label;
};

/** The same keys in `aria-keyshortcuts` syntax, such as `Meta+Shift+2`. */
export const ariaShortcut = (keys: string) =>
  keys
    .split("-")
    .map((part) =>
      part === "Mod" ? (isApple() ? "Meta" : "Control") : part === "Ctrl" ? "Control" : part.length === 1 ? part.toUpperCase() : part,
    )
    .join("+");

/** Whether the selection head sits inside a syntax node with one of these names. */
const inside = (state: EditorState, names: string[]) => {
  for (
    let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(state.selection.main.head, -1);
    node;
    node = node.parent
  )
    if (names.includes(node.name)) return true;
  return false;
};
const lineStarts = (pattern: RegExp) => (state: EditorState) => pattern.test(state.doc.lineAt(state.selection.main.head).text);
const writable = (state: EditorState) => !state.readOnly;
const command = (run: (view: EditorView) => boolean) => (view: EditorView) => {
  run(view);
};

/**
 * Markdown actions on `@k2b/ui`'s text editor commands, labelled in the locale. Hosts pick and order them per place
 * and add their own; ids stay stable across locales.
 */
export const markdownActions = (locale?: string) => {
  const { t } = editorMessages.resolve(locale ? [locale] : []);
  const action = (id: string, icon: string, label: string, run: (view: EditorView) => boolean, extra: Partial<EditorAction> = {}) =>
    ({ id, icon, label, run: command(run), isEnabled: writable, ...extra }) satisfies EditorAction;
  return {
    bold: action("bold", "ti-bold", t.bold, textEditorCommands.bold, { shortcut: "Mod-b", isActive: (s) => inside(s, ["StrongEmphasis"]) }),
    italic: action("italic", "ti-italic", t.italic, textEditorCommands.italic, {
      shortcut: "Mod-i",
      isActive: (s) => inside(s, ["Emphasis"]),
    }),
    strikethrough: action("strikethrough", "ti-strikethrough", t.strikethrough, textEditorCommands.strike, {
      shortcut: "Mod-Shift-x",
      isActive: (s) => inside(s, ["Strikethrough"]),
    }),
    code: action("code", "ti-code", t.code, textEditorCommands.code, { isActive: (s) => inside(s, ["InlineCode"]) }),
    link: action("link", "ti-link", t.link, textEditorCommands.link, { shortcut: "Mod-k", isActive: (s) => inside(s, ["Link"]) }),
    heading1: action("heading1", "ti-h-1", t.heading1, textEditorCommands.heading1, { isActive: lineStarts(/^# /) }),
    heading2: action("heading2", "ti-h-2", t.heading2, textEditorCommands.heading2, { isActive: lineStarts(/^## /) }),
    heading3: action("heading3", "ti-h-3", t.heading3, textEditorCommands.heading3, { isActive: lineStarts(/^### /) }),
    bulletList: action("bulletList", "ti-list", t.bulletList, textEditorCommands.bulletList, { isActive: lineStarts(/^\s*[-*] /) }),
    numberedList: action("numberedList", "ti-list-numbers", t.numberedList, textEditorCommands.orderedList, {
      isActive: lineStarts(/^\s*\d+\. /),
    }),
    quote: action("quote", "ti-quote", t.quote, textEditorCommands.quote, { isActive: lineStarts(/^> ?/) }),
    codeBlock: action("codeBlock", "ti-code-plus", t.codeBlock, textEditorCommands.codeBlock),
    table: action("table", "ti-table", t.table, textEditorCommands.table),
  };
};
