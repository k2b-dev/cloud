import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { type CreateThemeOptions, createTheme } from "@uiw/codemirror-themes";

/**
 * Layout / chrome styles — shared between rich and raw modes. Deliberately
 * font-family-free so each mode can pick its own type system (rich = sans
 * with code-mark mono override, raw = full mono).
 */
const baseEditorCSS = EditorView.theme({
  "&": {
    overflow: "hidden",
    flex: "1",
    minHeight: "0",
    height: "100%",
    fontSize: "14px",
  },
  ".cm-line": {
    cursor: "text",
    maxWidth: "100%",
    overflow: "visible",
    padding: "0",
  },
  "&.cm-editor.cm-focused": { outline: "none" },
  ".cm-scroller": {
    overflow: "auto",
    maxWidth: "100%",
    margin: "0 auto",
  },
  // The content clips sideways, so it pads the table bleed: a Markdown table
  // widget reaches into this padding, and its lines and hover extend past the
  // text as in the Book.
  ".cm-content": {
    maxWidth: "100%",
    overflowX: "hidden",
    paddingInline: "0.5rem",
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
  "&:not(.cm-focused) .cm-activeLine": { backgroundColor: "transparent" },
  "&:not(.cm-focused) .cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-cursor": { borderLeftWidth: "2px" },
  ".cm-cursor-primary": {
    borderLeftWidth: "2px",
    borderLeftColor: "oklch(62.3% 0.214 259.815)",
  },
  // Yjs remote cursor label
  ".cm-ySelectionCaret": {
    overflow: "visible",
    zIndex: "1000",
  },
  ".cm-ySelectionCaret > .cm-ySelectionInfo": {
    top: "0.15em",
    left: "0.25rem",
    borderRadius: "var(--radius-md)",
    padding: "1px 4px",
    fontSize: "11px",
    fontFamily: "var(--font-sans) !important",
    color: "#fff",
    zIndex: "1000",
    pointerEvents: "none",
    opacity: "1",
    transitionDelay: "0s",
    whiteSpace: "nowrap",
    boxShadow: "0 1px 2px rgb(0 0 0 / 0.16)",
  },
});

/**
 * Rich-mode font: prose in Sans, code in Mono.
 *
 * `.cm-md-code` is applied per-range by `codeFontExtension` against the
 * markdown syntax tree (FencedCode / InlineCode / CodeBlock nodes).
 */
const richFontCSS = EditorView.theme({
  "&": { fontFamily: "var(--font-sans)" },
  ".cm-line": { fontFamily: "var(--font-sans)" },
  ".cm-md-code": { fontFamily: "var(--font-mono)" },
});

/**
 * Raw-mode font: full mono — raw mode is a literal source view, sans
 * would obscure the markdown structure.
 */
const rawFontCSS = EditorView.theme({
  "&": { fontFamily: "var(--font-mono)" },
  ".cm-line": { fontFamily: "var(--font-mono)" },
});

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
  { tag: [t.strong], color: "#24292e", fontWeight: "700" },
  { tag: [t.emphasis], color: "#24292e", fontStyle: "italic" },
  { tag: [t.deleted], color: "#b31d28", backgroundColor: "#ffeef0" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#e36209" },
  { tag: [t.url, t.escape, t.link], color: "#032f62" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.invalid, color: "#cb2431" },
  { tag: t.heading1, color: "#24292e", fontSize: "2em", fontWeight: "800" },
  { tag: t.heading2, color: "#24292e", fontSize: "1.75em", fontWeight: "700" },
  { tag: t.heading3, color: "#24292e", fontSize: "1.5em", fontWeight: "700" },
  { tag: t.heading4, color: "#24292e", fontSize: "1.25em", fontWeight: "700" },
  { tag: t.heading5, color: "#24292e", fontSize: "1.15em", fontWeight: "700" },
  { tag: t.heading6, color: "#24292e", fontSize: "1.05em", fontWeight: "700" },
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
  { tag: [t.heading, t.strong], color: "#d2a8ff", fontWeight: "bold" },
  { tag: [t.emphasis], color: "#d2a8ff", fontStyle: "italic" },
  { tag: [t.deleted], color: "#ffdcd7", backgroundColor: "#ffeef0" },
  { tag: [t.atom, t.bool, t.special(t.variableName)], color: "#ffab70" },
  { tag: t.link, textDecoration: "underline" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.invalid, color: "#f97583" },
  { tag: t.heading1, color: "#d2a8ff", fontSize: "2em", fontWeight: "800" },
  { tag: t.heading2, color: "#d2a8ff", fontSize: "1.75em", fontWeight: "700" },
  { tag: t.heading3, color: "#d2a8ff", fontSize: "1.5em", fontWeight: "700" },
  { tag: t.heading4, color: "#d2a8ff", fontSize: "1.25em", fontWeight: "700" },
  { tag: t.heading5, color: "#d2a8ff", fontSize: "1.15em", fontWeight: "700" },
  { tag: t.heading6, color: "#d2a8ff", fontSize: "1.1em", fontWeight: "700" },
  { tag: t.meta, color: "var(--color-gray-500)" },
];

export const customLightInit = (options?: Partial<CreateThemeOptions>) => {
  const { theme = "light", settings = {}, styles = [] } = options ?? {};
  return [
    createTheme({
      theme,
      settings: {
        background: "transparent",
        foreground: "#24292e",
        selection: "#BBDFFF",
        selectionMatch: "#BBDFFF",
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
        foreground: "#c9d1d9",
        caret: "#c9d1d9",
        selection: "#003d73",
        selectionMatch: "#003d73",
        gutterBackground: "transparent",
        lineHighlight: "#36334280",
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
      foreground: "#24292e",
      selection: "#BBDFFF",
      selectionMatch: "#BBDFFF",
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
      foreground: "#c9d1d9",
      caret: "#c9d1d9",
      selection: "#003d73",
      selectionMatch: "#003d73",
      gutterBackground: "transparent",
      lineHighlight: "#36334280",
    },
    styles: [],
  }),
  baseEditorCSS,
  rawFontCSS,
];
