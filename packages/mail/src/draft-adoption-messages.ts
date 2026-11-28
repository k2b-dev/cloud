import { i18n } from "@k2b/stdlib";

export const draftAdoptionMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      replyOccupied: ({ draftId }: { draftId: string }) =>
        `Reply draft ${draftId} already exists. Open it and apply your content explicitly; no supplied content was saved.`,
      occupiedUpdateHint: ({ revision }: { revision: number }) =>
        `Write your content into it with mail.draft.patch at expectedRevision ${revision}.`,
      occupiedIntentHint: ({ revision }: { revision: number }) => `Switch its mode with mail.draft.intent at expectedRevision ${revision}.`,
      adopted: "A person has edited this draft. Ask them to initiate further changes.",
      mergeConflict: "Both conversations have an open reply draft. Send or discard one before merging them.",
    },
    de: {
      replyOccupied: ({ draftId }: { draftId: string }) =>
        `Antwortentwurf ${draftId} ist bereits vorhanden. Öffne ihn und übernimm deinen Inhalt ausdrücklich; der übergebene Inhalt wurde nicht gespeichert.`,
      occupiedUpdateHint: ({ revision }: { revision: number }) =>
        `Trage deinen Inhalt mit mail.draft.patch bei expectedRevision ${revision} ein.`,
      occupiedIntentHint: ({ revision }: { revision: number }) =>
        `Wechsle den Modus mit mail.draft.intent bei expectedRevision ${revision}.`,
      adopted: "Eine Person hat diesen Entwurf bearbeitet. Weitere Änderungen müssen von ihr beauftragt werden.",
      mergeConflict: "Beide Unterhaltungen haben einen offenen Antwortentwurf. Sende oder verwirf einen davon vor dem Zusammenführen.",
    },
  },
});
