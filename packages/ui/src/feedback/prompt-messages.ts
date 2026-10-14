import { i18n } from "@k2b/stdlib";
import { useLocale } from "../intl/locale";

const promptMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      minCharacters: ({ count }: { count: number }) => `At least ${count} ${count === 1 ? "character" : "characters"}`,
      maxCharacters: ({ count }: { count: number }) => `At most ${count} ${count === 1 ? "character" : "characters"}`,
      minTags: ({ count }: { count: number }) => `At least ${count} ${count === 1 ? "tag" : "tags"}`,
      maxTags: ({ count }: { count: number }) => `At most ${count} ${count === 1 ? "tag" : "tags"}`,
      searchFailed: "Search failed.",
      confirmation: "Confirmation",
      typeToConfirm: ({ phrase }: { phrase: string }) => `Type ${phrase} to confirm`,
      confirm: "Confirm",
      discard: "Discard",
      form: "Form",
      discardUnsavedChanges: "Discard unsaved changes?",
      unsavedChangesTitle: "Unsaved changes",
    },
    de: {
      minCharacters: ({ count }) => `Mindestens ${count} Zeichen`,
      maxCharacters: ({ count }) => `Höchstens ${count} Zeichen`,
      minTags: ({ count }) => `Mindestens ${count} ${count === 1 ? "Tag" : "Tags"}`,
      maxTags: ({ count }) => `Höchstens ${count} ${count === 1 ? "Tag" : "Tags"}`,
      searchFailed: "Suche fehlgeschlagen.",
      confirmation: "Bestätigung",
      typeToConfirm: ({ phrase }: { phrase: string }) => `Gib ${phrase} zur Bestätigung ein`,
      confirm: "Bestätigen",
      discard: "Verwerfen",
      form: "Formular",
      discardUnsavedChanges: "Ungespeicherte Änderungen verwerfen?",
      unsavedChangesTitle: "Ungespeicherte Änderungen",
    },
  },
});

export type PromptMessages = ReturnType<(typeof promptMessages)["resolve"]>["t"];

/** Resolved from the inherited render locale. */
export const usePromptMessages = (): (() => PromptMessages) => {
  const locale = useLocale();
  return () => promptMessages.resolve([locale()]).t;
};

/** Imperative UI inherits the document locale when no locale is supplied. */
export const resolvePromptMessages = (locale?: string): PromptMessages =>
  promptMessages.resolve([locale ?? (typeof document === "undefined" ? promptMessages.baseLocale : document.documentElement.lang)]).t;

export const checkPromptMessages = () => promptMessages.check();
