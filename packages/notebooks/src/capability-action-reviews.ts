import type { CapabilityActionCallReview } from "@k2b/cloud/contracts";

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
    /** Short facts, such as the notebook and the parent note, as label and value. */
    details: { label: string; value: string }[];
    /** The note's or comment's Markdown, drawn by Cloud's safe renderer under the facts. */
    markdown?: string;
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
  return {
    locale: language,
    sentence: sentences[language][operation],
    slots: { item: { kind: "object", title } },
    view: {
      version: 1 as const,
      blocks: [
        // The question already says what happens; the details name where, and the text follows as it will read.
        ...(proposal.details.length ? [{ kind: "Detail" as const, title, items: proposal.details }] : []),
        ...(proposal.markdown?.trim() ? [{ kind: "Text" as const, text: proposal.markdown, format: "markdown" as const }] : []),
      ],
    },
    scope: proposal.scope,
    links: proposal.links,
  };
};
