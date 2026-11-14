import type { CapabilityActionCallReview, CapabilityActionReview } from "@k2b/cloud/contracts";

const sentences = {
  en: {
    "tag.change": {
      action: "Change tags on {item}",
      running: "Changing tags on {item}",
      done: "Changed tags on {item}",
      confirm: "Change tags",
      decline: "Cancel",
    },
    "note.create": {
      action: "Add a note to {item}",
      running: "Adding a note to {item}",
      done: "Added a note to {item}",
      confirm: "Create note",
      decline: "Cancel",
    },
  },
  de: {
    "tag.change": {
      action: "Tags von {item} ändern",
      running: "Tags von {item} werden geändert",
      done: "Tags von {item} geändert",
      confirm: "Tags ändern",
      decline: "Abbrechen",
    },
    "note.create": {
      action: "Notiz zu {item} hinzufügen",
      running: "Notiz zu {item} wird hinzugefügt",
      done: "Notiz zu {item} hinzugefügt",
      confirm: "Notiz erstellen",
      decline: "Abbrechen",
    },
  },
};

/** Full proposed text remains available even when the compact review is shortened. */
export const contactAutomationReview = (
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
