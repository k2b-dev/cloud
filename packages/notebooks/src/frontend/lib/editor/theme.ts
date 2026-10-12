import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { type CreateThemeOptions, createTheme } from "@uiw/codemirror-themes";

/**
 * Layout / chrome styles — shared between rich and raw modes. Deliberately
 * font-free so each mode can pick its own type system (rich = 16px sans
 * with code-mark mono override, raw = 14px mono).
 */
const baseEditorCSS = EditorView.theme({
  "&": {
    overflow: "hidden",
    flex: "1",
    minHeight: "0",
    height: "100%",
  },
  ".cm-line": {
    cursor: "text",
    maxWidth: "100%",
    overflow: "visible",
    padding: "0",
  },
  "&.cm-editor.cm-focused": { outline: "none" },
  // The scroller, not the content, clips sideways: a Markdown table widget
  // reaches past the text into the scroller's inline padding, so its lines and
  // hover extend past the text as in the Book. The content keeps the text's
  // edges, which CodeMirror draws selections from.
  ".cm-scroller": {
    overflow: "auto",
    overflowX: "hidden",
    maxWidth: "100%",
    margin: "0 auto",
  },
  // The reading column of the app's stylesheet (`--notebook-measure`), the
  // same width as the Book's text. Each mode centers it in the free space.
  ".cm-content": {
    maxWidth: "min(100%, var(--notebook-measure))",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    marginRight: "12px",
  },
  // Gutter / line numbers always mono for tabular alignment, regardless
  // of the rich/raw body font.
  ".cm-gutterElement": {
    color: "var(--color-gray-500)",
    fontFamily: "var(--font-mono) !important",
    fontSize: "12px",
    paddingRight: "8px",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    paddingLeft: "8px",
  },
  ".cm-foldPlaceholder": { backgroundColor: "transparent", border: "none" },
  ".cm-cursor": { borderLeftWidth: "2px" },
  ".cm-cursor-primary": {
    borderLeftWidth: "2px",
    borderLeftColor: "oklch(62.3% 0.214 259.815)",
  },
});

/**
 * The note page's arrangement: CodeMirror grows inside the page's scroll area
 * and insets the text by 1rem, also on a phone. The reading column centers in
 * the rest.
 */
export const noteScrollerTheme = EditorView.theme({
  ".cm-editor": { minHeight: "100%" },
  ".cm-scroller": { width: "100%", minHeight: "100%", padding: "1rem" },
});

/**
 * Rich-mode type: prose in Sans at the Book's size and line height, so a
 * paragraph breaks into the same lines while writing and reading; code in Mono.
 *
 * `.cm-md-code` is applied per-range by `codeFontExtension` against the
 * markdown syntax tree (FencedCode / InlineCode / CodeBlock nodes).
 */
const richFontCSS = EditorView.theme({
  "&": { fontFamily: "var(--font-sans)", fontSize: "16px" },
  ".cm-scroller": { lineHeight: "1.6" },
  ".cm-line": { fontFamily: "var(--font-sans)" },
  ".cm-md-code": { fontFamily: "var(--font-mono)" },
  ".cm-content": { marginInline: "auto" },
  // CodeMirror wraps with `break-spaces`, where a space at the end of a line
  // takes room and pushes the last word down. The Book lets it hang, so the
  // editor does too and both break a paragraph at the same words.
  "&.cm-editor .cm-lineWrapping": { whiteSpace: "pre-wrap" },
});

/**
 * Raw-mode type: full mono — raw mode is a literal source view, sans
 * would obscure the markdown structure. The line numbers travel with the
 * column, so numbers and text center together.
 */
const rawFontCSS = EditorView.theme({
  "&": { fontFamily: "var(--font-mono)", fontSize: "14px" },
  ".cm-line": { fontFamily: "var(--font-mono)" },
  ".cm-gutters": { marginLeft: "auto" },
  ".cm-content": { marginRight: "auto" },
});

/** The Book's text colors (`.notebook-book-shell`), so writing and reading look alike. */
const lightText = "var(--color-zinc-950)";
const darkText = "var(--color-zinc-100)";

/**
 * The heading scale of the Book (`.notebook-book-content` in the app's
 * stylesheet). Headings, bold and italic keep the text color in both themes;
 * only code is highlighted.
 */
const headingStyles: CreateThemeOptions["styles"] = [
  { tag: t.heading1, fontSize: "1.875em", fontWeight: "650", lineHeight: "1.25" },
  { tag: t.heading2, fontSize: "1.5em", fontWeight: "650", lineHeight: "1.3" },
  { tag: t.heading3, fontSize: "1.25em", fontWeight: "650", lineHeight: "1.4" },
  { tag: t.heading4, fontSize: "1.125em", fontWeight: "650" },
  { tag: [t.heading5, t.heading6], fontSize: "1em", fontWeight: "650" },
];

const customLightStyle: CreateThemeOptions["styles"] = [
  { tag: [t.standard(t.tagName), t.tagName], color: "#116329" },
  { tag: [t.comment, t.bracket], color: "#6a737d" },
  { tag: [t.className, t.propertyName], color: "#6f42c1" },
  {
    tag: [t.variableName, t.attributeName, t.number, t.operator],
    color: "#005cc5",
  },
  {
    tag: [t.keyword, t.typeName, t.typeOperator],
    color: "#d73a49",
  },
  { tag: [t.string, t.regexp], color: "#032f62" },
  { tag: [t.name, t.quote], color: "#22863a" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.deleted], color: "#b31d28", backgroundColor: "#ffeef0" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#e36209" },
  { tag: [t.url, t.escape, t.link], color: "#032f62" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.invalid, color: "#cb2431" },
  ...headingStyles,
  { tag: t.meta, color: "var(--color-gray-400)" },
];

const customDarkStyle: CreateThemeOptions["styles"] = [
  { tag: [t.standard(t.tagName), t.tagName], color: "#7ee787" },
  { tag: [t.comment, t.bracket], color: "#8b949e" },
  { tag: [t.className, t.propertyName], color: "#d2a8ff" },
  {
    tag: [t.variableName, t.attributeName, t.number, t.operator],
    color: "#79c0ff",
  },
  {
    tag: [t.keyword, t.typeName, t.typeOperator],
    color: "#ff7b72",
  },
  { tag: [t.string, t.regexp], color: "#a5d6ff" },
  { tag: [t.name, t.quote], color: "#7ee787" },
  { tag: [t.strong], fontWeight: "700" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.deleted], color: "#ffdcd7", backgroundColor: "#ffeef0" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#ffab70" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.invalid, color: "#f97583" },
  ...headingStyles,
  { tag: t.meta, color: "var(--color-gray-500)" },
];

export const customLightInit = (options?: Partial<CreateThemeOptions>) => {
  const { theme = "light", settings = {}, styles = [] } = options ?? {};
  return [
    createTheme({
      theme,
      settings: {
        background: "transparent",
        foreground: lightText,
        selection: "#BBDFFF",
        selectionMatch: "#e4e4e7",
        gutterBackground: "transparent",
        gutterForeground: "#6e7781",
        ...settings,
      },
      styles: [...customLightStyle, ...styles],
    }),
    baseEditorCSS,
    richFontCSS,
  ];
};

export const customDarkInit = (options?: Partial<CreateThemeOptions>) => {
  const { theme = "dark", settings = {}, styles = [] } = options ?? {};
  return [
    createTheme({
      theme,
      settings: {
        background: "transparent",
        foreground: darkText,
        caret: darkText,
        selection: "#003d73",
        selectionMatch: "#3f3f46",
        gutterBackground: "transparent",
        ...settings,
      },
      styles: [...customDarkStyle, ...styles],
    }),
    baseEditorCSS,
    richFontCSS,
  ];
};

/** Raw mode themes — editor CSS only, no syntax highlighting styles */
export const rawLightInit = () => [
  createTheme({
    theme: "light",
    settings: {
      background: "transparent",
      foreground: lightText,
      selection: "#BBDFFF",
      selectionMatch: "#e4e4e7",
      gutterBackground: "transparent",
      gutterForeground: "#6e7781",
    },
    styles: [],
  }),
  baseEditorCSS,
  rawFontCSS,
];

export const rawDarkInit = () => [
  createTheme({
    theme: "dark",
    settings: {
      background: "transparent",
      foreground: darkText,
      caret: darkText,
      selection: "#003d73",
      selectionMatch: "#3f3f46",
      gutterBackground: "transparent",
    },
    styles: [],
  }),
  baseEditorCSS,
  rawFontCSS,
];
