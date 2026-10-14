import { i18n } from "@k2b/stdlib";
import { useLocale } from "../../intl/locale";

const markdownEditorMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      saveShortcut: "Save (Ctrl/Cmd+S)",
      editorLines: ({ count, value }: { count: number; value: string }) => `${value} ${count === 1 ? "line" : "lines"}`,
      editorWords: ({ count, value }: { count: number; value: string }) => `${value} ${count === 1 ? "word" : "words"}`,
      editorCharacters: ({ count, value }: { count: number; value: string }) => `${value} ${count === 1 ? "char" : "chars"}`,
    },
    de: {
      saveShortcut: "Speichern (Strg/Cmd+S)",
      editorLines: ({ count, value }) => `${value} ${count === 1 ? "Zeile" : "Zeilen"}`,
      editorWords: ({ count, value }) => `${value} ${count === 1 ? "Wort" : "Wörter"}`,
      editorCharacters: ({ value }) => `${value} Zeichen`,
    },
  },
});

export type MarkdownEditorMessages = ReturnType<(typeof markdownEditorMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const useMarkdownEditorMessages = (): (() => MarkdownEditorMessages) => {
  const locale = useLocale();
  return () => markdownEditorMessages.resolve([locale()]).t;
};

export const checkMarkdownEditorMessages = () => markdownEditorMessages.check();
