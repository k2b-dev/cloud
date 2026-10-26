import { i18n } from "@k2b/stdlib";

const plural = (count: number, one: string, other: string) => (count === 1 ? one : other);

export const mailSummaryMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      title: "In short",
      aiLabel: "AI summary",
      writing: "being written …",
      rewrite: "Write again",
      edit: "Edit summary",
      why: "How this summary came about",
      newSince: ({ count }: { count: number }) => `${count} new ${plural(count, "message", "messages")} since this version`,
      continue: "Continue",
      nextStep: "Next step",
      remind: "Remind me",
      fromMessages: ({ count }: { count: number }) => `From ${count} ${plural(count, "message", "messages")}`,
      fromNewest: ({ count }: { count: number }) => `From the newest ${count} ${plural(count, "message", "messages")}`,
      byRule: ({ name }: { name: string }) => `Rule “${name}”`,
      onRequestOf: ({ name }: { name: string }) => `AI on request of ${name}`,
      byPerson: ({ name }: { name: string }) => `Written by ${name}`,
      editedByPerson: "Written by a person",
      failed_timeout: "The summary was not written: the AI did not answer in time. The conversation is unchanged.",
      failed_provider_unavailable: "The summary was not written: the AI is not reachable right now. The conversation is unchanged.",
      failed_input_too_large: "The summary was not written: the conversation is too long for the AI. The conversation is unchanged.",
      failed_allowance_exhausted: "The summary was not written: your AI allowance is used up for now. The conversation is unchanged.",
      failed_internal: "The summary was not written: something went wrong. The conversation is unchanged.",
      updateFailed: "Continuing the summary did not work. The shown version stays.",
      tryAgain: "Try again",
      attempts: ({ count, time }: { count: number; time: string }) => `${count} ${plural(count, "attempt", "attempts")}, last at ${time}`,
      limitRule: ({ limit, name }: { limit: number; name: string }) =>
        `No more automatic summaries today: the daily limit of ${limit} AI calls for “${name}” is reached. It continues after midnight. The mail is unchanged.`,
      limitMailbox: ({ limit }: { limit: number }) =>
        `No more automatic summaries today: the daily limit of ${limit} AI calls for this mailbox is reached. It continues after midnight. The mail is unchanged.`,
      summarizeThisOne: "Summarize this one now",
      countsOnAllowance: "Counts on your personal AI allowance",
      allowanceUsed: ({ percent }: { percent: number }) => `${percent} % used`,
      summarizeWithAi: "Summarize with AI",
      whyAi: ({ rule }: { rule: string | null }) =>
        `Written by AI${rule ? ` for the rule “${rule}”` : ""}. It reads the messages without quotes and signatures and only writes this text; it changes nothing else.`,
      whyPerson: "Written by a person. Rules do not overwrite it; “Continue” lets the AI add the new messages.",
      justNow: "just now",
      minutesAgo: ({ minutes }: { minutes: number }) => `${minutes} min ago`,
      hoursAgo: ({ hours }: { hours: number }) => `${hours} h ago`,
      generateFailed: "The summary could not be started",
    },
    de: {
      title: "Kurz gesagt",
      aiLabel: "KI-Zusammenfassung",
      writing: "wird geschrieben …",
      rewrite: "Neu schreiben",
      edit: "Zusammenfassung bearbeiten",
      why: "Wie diese Zusammenfassung entstand",
      newSince: ({ count }: { count: number }) => `${count} neue ${plural(count, "Nachricht", "Nachrichten")} seit dieser Fassung`,
      continue: "Fortschreiben",
      nextStep: "Nächster Schritt",
      remind: "Erinnern",
      fromMessages: ({ count }: { count: number }) => `Aus ${count} ${plural(count, "Nachricht", "Nachrichten")}`,
      fromNewest: ({ count }: { count: number }) => `Aus den neuesten ${count} ${plural(count, "Nachricht", "Nachrichten")}`,
      byRule: ({ name }: { name: string }) => `Regel „${name}“`,
      onRequestOf: ({ name }: { name: string }) => `KI auf Wunsch von ${name}`,
      byPerson: ({ name }: { name: string }) => `Von ${name} geschrieben`,
      editedByPerson: "Von einer Person geschrieben",
      failed_timeout:
        "Die Zusammenfassung ist nicht entstanden: Die KI hat nicht rechtzeitig geantwortet. Die Unterhaltung ist unverändert.",
      provider_unavailable:
        "Die Zusammenfassung ist nicht entstanden: Die KI ist gerade nicht erreichbar. Die Unterhaltung ist unverändert.",
      input_too_large:
        "Die Zusammenfassung ist nicht entstanden: Die Unterhaltung ist zu lang für die KI. Die Unterhaltung ist unverändert.",
      allowance_exhausted:
        "Die Zusammenfassung ist nicht entstanden: Dein KI-Kontingent ist gerade aufgebraucht. Die Unterhaltung ist unverändert.",
      failed_internal: "Die Zusammenfassung ist nicht entstanden: Etwas ist schiefgegangen. Die Unterhaltung ist unverändert.",
      updateFailed: "Fortschreiben hat nicht geklappt. Die gezeigte Fassung bleibt.",
      tryAgain: "Erneut versuchen",
      attempts: ({ count, time }: { count: number; time: string }) => `${count} ${plural(count, "Versuch", "Versuche")}, zuletzt ${time}`,
      limitRule: ({ limit, name }: { limit: number; name: string }) =>
        `Heute keine automatischen Zusammenfassungen mehr: Das Tageslimit von ${limit} KI-Aufrufen für „${name}“ ist erreicht. Ab Mitternacht geht es weiter. Die Mail ist unverändert.`,
      limitMailbox: ({ limit }: { limit: number }) =>
        `Heute keine automatischen Zusammenfassungen mehr: Das Tageslimit von ${limit} KI-Aufrufen für dieses Postfach ist erreicht. Ab Mitternacht geht es weiter. Die Mail ist unverändert.`,
      summarizeThisOne: "Diese eine jetzt zusammenfassen",
      countsOnAllowance: "Zählt auf dein persönliches KI-Kontingent",
      allowanceUsed: ({ percent }: { percent: number }) => `${percent} % genutzt`,
      summarizeWithAi: "Mit KI zusammenfassen",
      whyAi: ({ rule }: { rule: string | null }) =>
        `Von der KI geschrieben${rule ? ` für die Regel „${rule}“` : ""}. Sie liest die Nachrichten ohne Zitate und Signaturen und schreibt nur diesen Text; sonst ändert sie nichts.`,
      whyPerson:
        "Von einer Person geschrieben. Regeln überschreiben diesen Text nicht; „Fortschreiben“ lässt die KI die neuen Nachrichten ergänzen.",
      justNow: "gerade eben",
      minutesAgo: ({ minutes }: { minutes: number }) => `vor ${minutes} Min.`,
      hoursAgo: ({ hours }: { hours: number }) => `vor ${hours} Std.`,
      generateFailed: "Die Zusammenfassung konnte nicht gestartet werden",
    },
  },
});
