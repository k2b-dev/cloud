import type { CapabilityActionCallReview, CloudResourceRef } from "@k2b/cloud/contracts";

const sentences = {
  en: {
    post: {
      action: "Post a message to {item}",
      running: "Posting a message to {item}",
      done: "Posted a message to {item}",
      confirm: "Post",
      decline: "Cancel",
    },
    edit: {
      action: "Edit your message in {item}",
      running: "Editing your message in {item}",
      done: "Edited your message in {item}",
      confirm: "Save",
      decline: "Cancel",
    },
    delete: {
      action: "Permanently delete your message in {item}",
      running: "Deleting your message in {item}",
      done: "Deleted your message in {item}",
      confirm: "Delete",
      decline: "Cancel",
    },
  },
  de: {
    post: {
      action: "Nachricht zu {item} senden",
      running: "Nachricht zu {item} wird gesendet",
      done: "Nachricht zu {item} gesendet",
      confirm: "Senden",
      decline: "Abbrechen",
    },
    edit: {
      action: "Eigene Nachricht in {item} ändern",
      running: "Eigene Nachricht in {item} wird geändert",
      done: "Eigene Nachricht in {item} geändert",
      confirm: "Speichern",
      decline: "Abbrechen",
    },
    delete: {
      action: "Eigene Nachricht in {item} endgültig löschen",
      running: "Eigene Nachricht in {item} wird gelöscht",
      done: "Eigene Nachricht in {item} gelöscht",
      confirm: "Löschen",
      decline: "Abbrechen",
    },
  },
};

/** Keep the compact approval bounded, with the complete proposed/deleted text in its authorized content view. */
export const discussionReview = (
  operation: "post" | "edit" | "delete",
  item: CloudResourceRef,
  title: string,
  body: string,
  locale?: string,
  revision?: number,
): CapabilityActionCallReview => {
  const language = locale?.startsWith("de") ? "de" : "en";
  const label =
    title
      .replace(/[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029]/gu, " ")
      .slice(0, 200)
      .toWellFormed() || "—";
  return {
    locale: language,
    sentence: sentences[language][operation],
    slots: { item: { kind: "object", title: label, ref: item } },
    content: { kind: "page", title: label, body, format: "plain", ...(revision === undefined ? {} : { baseRevision: revision }) },
    ...(operation === "post" ? { reach: "shared" as const } : {}),
  };
};

/** The approval contract caps scope at 200 characters; resource IDs can be 512. */
export const discussionApprovalScope = (container: CloudResourceRef) =>
  `container:${new Bun.CryptoHasher("sha256").update(JSON.stringify([container.type, container.id])).digest("hex")}`;
