import type { CapabilityActionCallReview, CapabilityActionReview } from "@k2b/cloud/contracts";

const sentences = {
  en: {
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
  const rows = proposal.details.map(({ label, value, format }) => ({
    label,
    value: String(value)
      .toWellFormed()
      .replace(/\r\n?/g, "\n")
      .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, (char) => (char === "\n" || char === "\t" ? char : "")),
    ...(format === "date" || format === "date-time" ? { format } : {}),
  }));
  // Keep date fields typed even when long text needs a page preview.
  const completeBody = proposal.details.map(({ label, value }) => `${label}: ${value}`).join("\n\n");
  const normalizedBody = rows.map(({ label, value }) => `${label}: ${value}`).join("\n\n");
  const body = rows
    .filter(({ format }) => format === undefined)
    .map(({ label, value }) => `${label}: ${value}`)
    .join("\n\n");
  const fieldsFit = normalizedBody === completeBody && rows.length <= 12 && rows.every(({ value }) => value.length <= 2000);
  return {
    ...(fieldsFit
      ? { preview: { kind: "fields" as const, rows } }
      : {
          preview: {
            kind: "page" as const,
            title,
            body: body.slice(0, 10_000).toWellFormed(),
            format: "plain" as const,
            truncated: body.length > 10_000 || normalizedBody !== completeBody,
          },
          consequences: rows.flatMap(({ label, value, format }) =>
            format ? [{ text: `${label}: {at}`, slots: { at: { kind: "time" as const, start: value, format } } }] : [],
          ),
        }),
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
