import { i18n } from "@k2b/stdlib";
import { useLocale } from "../../intl/locale";

const markdownToolbarMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      boldShortcut: "Bold (Ctrl/Cmd+B)",
      bulletListShortcut: "Bullet list (Ctrl/Cmd+Shift+8)",
      heading1Shortcut: "Heading 1 (Ctrl/Cmd+Shift+1)",
      heading2Shortcut: "Heading 2 (Ctrl/Cmd+Shift+2)",
      heading3Shortcut: "Heading 3 (Ctrl/Cmd+Shift+3)",
      inlineCodeShortcut: "Inline code (Ctrl/Cmd+E)",
      italicShortcut: "Italic (Ctrl/Cmd+I)",
      linkShortcut: "Link (Ctrl/Cmd+K)",
      markdownFormatting: "Markdown formatting",
      numberedListShortcut: "Numbered list (Ctrl/Cmd+Shift+7)",
      quote: "Quote",
    },
    de: {
      boldShortcut: "Fett (Strg/Cmd+B)",
      bulletListShortcut: "Aufzählung (Strg/Cmd+Umschalt+8)",
      heading1Shortcut: "Überschrift 1 (Strg/Cmd+Umschalt+1)",
      heading2Shortcut: "Überschrift 2 (Strg/Cmd+Umschalt+2)",
      heading3Shortcut: "Überschrift 3 (Strg/Cmd+Umschalt+3)",
      inlineCodeShortcut: "Inline-Code (Strg/Cmd+E)",
      italicShortcut: "Kursiv (Strg/Cmd+I)",
      linkShortcut: "Link (Strg/Cmd+K)",
      markdownFormatting: "Markdown-Formatierung",
      numberedListShortcut: "Nummerierte Liste (Strg/Cmd+Umschalt+7)",
      quote: "Zitat",
    },
  },
});

export type MarkdownToolbarMessages = ReturnType<(typeof markdownToolbarMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useMarkdownToolbarMessages = (): (() => MarkdownToolbarMessages) => {
  const locale = useLocale();
  return () => markdownToolbarMessages.resolve([locale()]).t;
};

export const checkMarkdownToolbarMessages = () => markdownToolbarMessages.check();
