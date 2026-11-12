import { i18n } from "@k2b/stdlib";

export const draftAdoptionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      adopted: "A person has edited this draft. Ask them to initiate further changes.",
      mergeConflict: "Both conversations have an open reply draft. Send or discard one before merging them.",
    },
    de: {
      adopted: "Eine Person hat diesen Entwurf bearbeitet. Weitere Änderungen müssen von ihr beauftragt werden.",
      mergeConflict: "Beide Unterhaltungen haben einen offenen Antwortentwurf. Sende oder verwirf einen davon vor dem Zusammenführen.",
    },
  },
});
