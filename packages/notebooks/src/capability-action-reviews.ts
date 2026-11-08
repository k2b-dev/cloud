import type { CapabilityActionCallReview, CapabilityActionReview } from "@k2b/cloud/contracts";

const sentences = {
  en: {
    "comment.create": {
      action: "Comment on {item}",
      running: "Commenting on {item}",
      done: "Commented on {item}",
      confirm: "Add comment",
      decline: "Cancel",
    },
    "note.create": {
      action: "Create a note in {item}",
      running: "Creating a note in {item}",
      done: "Created a note in {item}",
      confirm: "Create note",
      decline: "Cancel",
    },
  },
  de: {
    "comment.create": {
      action: "Beitrag zu {item} hinzufügen",
      running: "Beitrag zu {item} wird hinzugefügt",
      done: "Beitrag zu {item} hinzugefügt",
      confirm: "Beitrag hinzufügen",
      decline: "Abbrechen",
    },
    "note.create": {
      action: "Notiz in {item} erstellen",
      running: "Notiz in {item} wird erstellt",
      done: "Notiz in {item} erstellt",
      confirm: "Notiz erstellen",
      decline: "Abbrechen",
    },
  },
};

/** Full proposed text remains available even when the compact review is shortened. */
export const notebookAutomationReview = (
  operation: keyof typeof sentences.en,
  locale: string | undefined,
  proposal: {
    title: string;
    message: string;
    details: NonNullable<CapabilityActionReview["details"]>;
    scope: string;
    links: CapabilityActionCallReview["links"];
  },
): CapabilityActionCallReview => {
  const language = locale?.startsWith("de") ? "de" : "en";
  const title =
    proposal.title
      .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, " ")
      .slice(0, 200)
      .toWellFormed() || "—";
  const compact = (value: string, max: number) =>
    value
      .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, " ")
      .slice(0, max)
      .toWellFormed() || "—";
  return {
    preview: {
      kind: "page",
      title,
      format: "plain",
      body: proposal.details
        .slice(0, 12)
        .map(({ label, value }) => `${compact(label, 60)}: ${compact(value, 200)}`)
        .join("\n"),
      truncated: true,
    },
    locale: language,
    sentence: sentences[language][operation],
    slots: { item: { kind: "object", title } },
    content: {
      kind: "page",
      title,
      format: "plain",
      body: [proposal.message, ...proposal.details.map(({ label, value }) => `${label}: ${value}`)].join("\n\n"),
    },
    scope: proposal.scope,
    links: proposal.links,
  };
};
