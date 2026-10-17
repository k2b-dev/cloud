import type { ContactPresenceFilter } from "../../service";
import type { ResultsMessages } from "./results-messages";

export type ContactsScope = "all" | "favorites" | "book" | "noBooks";

type EmptyStateInput = {
  scope: ContactsScope;
  canWrite: boolean;
  search: string;
  tagId: string | null;
  email: ContactPresenceFilter;
  phone: ContactPresenceFilter;
  favorites: boolean;
};

export function contactsEmptyState(
  input: EmptyStateInput,
  t: ResultsMessages,
): { title: string; description: string; action: "createBook" | null } {
  if (input.scope === "noBooks") {
    return { title: t.emptyNoBooksTitle, description: t.emptyNoBooksHint, action: "createBook" };
  }
  if (input.search.trim()) {
    return { title: t.noMatchingContacts, description: t.noMatchingContactsHint, action: null };
  }
  if (
    input.tagId ||
    input.email !== "all" ||
    input.phone !== "all" ||
    (input.favorites && (input.scope === "book" || input.scope === "all"))
  ) {
    return { title: t.noMatchingContacts, description: t.noMatchingFiltersHint, action: null };
  }
  if (input.scope === "favorites") {
    return { title: t.emptyFavoritesTitle, description: t.emptyFavoritesHint, action: null };
  }
  if (input.scope === "book") {
    return { title: t.emptyBookTitle, description: input.canWrite ? t.emptyBookHint : t.emptyReadOnlyHint, action: null };
  }
  return { title: t.emptyAllTitle, description: input.canWrite ? t.emptyAllHint : t.emptyReadOnlyHint, action: null };
}
