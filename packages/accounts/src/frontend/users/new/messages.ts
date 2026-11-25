import { i18n } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";

/** The words of the new-user page on v2 that Accounts' shared catalog does not have yet. */
export const newUserMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      optional: "optional",
      discardTitle: "Discard the new account?",
      discardDescription: "What you entered is lost.",
      discard: "Discard",
      requestFrom: ({ name }: { name: string }) => `Request from ${name}`,
      backToUsers: "Back to users",
      result: "Result",
    },
    de: {
      optional: "optional",
      discardTitle: "Neues Konto verwerfen?",
      discardDescription: "Deine Eingaben gehen verloren.",
      discard: "Verwerfen",
      requestFrom: ({ name }) => `Antrag von ${name}`,
      backToUsers: "Zurück zu den Benutzern",
      result: "Ergebnis",
    },
  },
});

export type NewUserMessages = ReturnType<typeof newUserMessages.resolve>["t"];

export const useNewUserMessages = () => {
  const locale = useLocale();
  return createMemo(() => newUserMessages.resolve([locale()]).t);
};
