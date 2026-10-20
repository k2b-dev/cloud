import { announce } from "@k2b/ui";
import type { Contact } from "../../service";

export const contactOutcomeHref = (contact: Pick<Contact, "bookId" | "id">, outcome: "created" | "updated" | "moved") => {
  const query = new URLSearchParams({ contact: contact.id, contactBook: contact.bookId, contactOutcome: outcome });
  return `/app/contacts/${encodeURIComponent(contact.bookId)}?${query}`;
};

/** The destination owns the announcement: a full document navigation destroys the old live region. */
export const announceContactOutcome = (
  contact: Pick<Contact, "bookId" | "id">,
  text: { contactCreated: string; contactUpdated: string; contactMoved: string },
) => {
  const url = new URL(window.location.href);
  if (url.searchParams.get("contact") !== contact.id || url.searchParams.get("contactBook") !== contact.bookId) return;
  const outcome = url.searchParams.get("contactOutcome");
  if (outcome !== "created" && outcome !== "updated" && outcome !== "moved") return;
  url.searchParams.delete("contactOutcome");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  announce(outcome === "created" ? text.contactCreated : outcome === "updated" ? text.contactUpdated : text.contactMoved);
};
