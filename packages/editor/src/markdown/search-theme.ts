import { EditorView } from "@codemirror/view";

export const searchTheme = () =>
  EditorView.theme({
    ".cm-panels": {
      backgroundColor: "transparent !important",
    },
    ".cm-panel.cm-search": {
      margin: "0 4px",
      padding: "0",
      "& > *": {
        margin: "0 4px 4px 0  !important",
      },
    },
    ".cm-panels-bottom": {
      borderTop: "none !important",
    },
    ".dark & .cm-textfield": {
      background: "var(--color-gray-800)",
    },
    ".cm-textfield": {
      borderRadius: "var(--radius-sm)",
      padding: "2px 4px",
      fontSize: "var(--text-xs)",
      color: "var(--color-gray-500)",
      boxShadow: "var(--shadow-sm)",
      border: 0,
      transition: "all 0.2s ease",
      "&:hover": {
        boxShadow: "var(--shadow-md)",
      },
      "&:focus": {
        outline: "none",
        boxShadow: "var(--shadow-md)",
      },
    },
    ".dark & .cm-button": {
      background: "var(--color-gray-800)",
    },
    ".cm-button": {
      backgroundImage: "none",
      borderRadius: "var(--radius-sm)",
      boxShadow: "var(--shadow-sm)",
      transition: "all 0.2s ease",
      border: "none",
      padding: "2px 4px",
      fontSize: "var(--text-xs)",
      color: "var(--color-gray-500)",
      cursor: "pointer",
      "&:hover": {
        transform: "translateY(-1px)",
        boxShadow: "var(--shadow-md)",
      },
      "&:focus": {
        outline: "none",
        boxShadow: "0 0 0 2px rgb(59 130 246 / 0.35)",
      },
    },
    ".dark & .cm-search button[name='close']": {
      "&:hover": {
        backgroundColor: "var(--color-gray-800)",
        color: "var(--color-gray-500)",
      },
    },
    ".cm-search button[name='close']": {
      backgroundColor: "transparent",
      border: "none",
      borderRadius: "var(--radius-sm)",
      width: "18px",
      height: "18px",
      fontSize: "var(--text-xs)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--color-gray-500)",
      fontWeight: "bold",
      cursor: "pointer",
      transition: "all 0.2s ease",
      fontFamily: "var(--font-mono)",
      "&:hover": {
        backgroundColor: "var(--color-gray-100)",
        color: "var(--color-gray-700)",
      },
    },
    ".cm-search label": {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      fontSize: "13px",
      color: "var(--color-gray-500)",
      cursor: "pointer",
      userSelect: "none",
      marginRight: "12px",
      "&:hover": {
        color: "var(--color-gray-700)",
      },
    },
  });
