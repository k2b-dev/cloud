import type { CapabilityActionCallReview, CapabilityActionReview } from "@k2b/cloud/contracts";

const sentences = {
  en: {
    "comment.create": {
      action: "Comment on {item}",
      running: "Commenting on {item}",
      done: "Commented on {item}",
      confirm: "Post",
      decline: "Cancel",
    },
    "item.tags.set": {
      action: "Set tags on {item}",
      running: "Setting tags on {item}",
      done: "Set tags on {item}",
      confirm: "Save",
      decline: "Cancel",
    },
    "task.create": {
      action: "Create task {item}",
      running: "Creating task {item}",
      done: "Created task {item}",
      confirm: "Create",
      decline: "Cancel",
    },
    "event.create": {
      action: "Create event {item}",
      running: "Creating event {item}",
      done: "Created event {item}",
      confirm: "Create",
      decline: "Cancel",
    },
    "task.update": {
      action: "Update task {item}",
      running: "Updating task {item}",
      done: "Updated task {item}",
      confirm: "Save",
      decline: "Cancel",
    },
    "item.reference.add": {
      action: "Link a resource to {item}",
      running: "Linking a resource to {item}",
      done: "Linked a resource to {item}",
      confirm: "Link",
      decline: "Cancel",
    },
  },
  de: {
    "comment.create": {
      action: "{item} kommentieren",
      running: "{item} wird kommentiert",
      done: "{item} kommentiert",
      confirm: "Posten",
      decline: "Abbrechen",
    },
    "item.tags.set": {
      action: "Tags für {item} setzen",
      running: "Tags für {item} werden gesetzt",
      done: "Tags für {item} gesetzt",
      confirm: "Speichern",
      decline: "Abbrechen",
    },
    "task.create": {
      action: "Aufgabe {item} anlegen",
      running: "Aufgabe {item} wird angelegt",
      done: "Aufgabe {item} angelegt",
      confirm: "Anlegen",
      decline: "Abbrechen",
    },
    "event.create": {
      action: "Termin {item} anlegen",
      running: "Termin {item} wird angelegt",
      done: "Termin {item} angelegt",
      confirm: "Anlegen",
      decline: "Abbrechen",
    },
    "task.update": {
      action: "Aufgabe {item} ändern",
      running: "Aufgabe {item} wird geändert",
      done: "Aufgabe {item} geändert",
      confirm: "Speichern",
      decline: "Abbrechen",
    },
    "item.reference.add": {
      action: "Ressource mit {item} verknüpfen",
      running: "Ressource wird mit {item} verknüpft",
      done: "Ressource mit {item} verknüpft",
      confirm: "Verknüpfen",
      decline: "Abbrechen",
    },
  },
};

/** Preserve every proposed field in the complete content, including long descriptions and assignee names. */
export const spacesActionReview = (
  operation: keyof typeof sentences.en,
  locale: string | undefined,
  proposal: {
    title: string;
    message: string;
    details: NonNullable<CapabilityActionReview["details"]>;
    scope: string;
    ask?: CapabilityActionCallReview["ask"];
    links?: CapabilityActionCallReview["links"];
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
    ...(proposal.ask ? { ask: proposal.ask } : {}),
    ...(proposal.links ? { links: proposal.links } : {}),
  };
};
