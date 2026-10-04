import type { ContactLiveEvent } from "../../live-events";

const CONTACTS_LIVE_INVALIDATION_EVENT = "contacts:live-invalidation";

type ContactsLiveOwner = "results" | "detail" | "notes";

type ContactsLiveSelection = {
  bookId: string | null;
  contactId: string | null;
};

type ContactsLiveInvalidationDispatch = {
  invalidation: ContactLiveEvent;
  cover: (owner: ContactsLiveOwner, work: Promise<void>) => void;
};

const requiredContactsLiveOwners = (invalidation: ContactLiveEvent, selection: ContactsLiveSelection): ContactsLiveOwner[] => {
  if (requiresContactsResultsRefresh(invalidation)) {
    if (selection.bookId && selection.contactId && requiresSelectedContactRefresh(invalidation, selection.bookId)) {
      return ["results", "detail"];
    }
    return ["results"];
  }
  if (invalidation.type === "notes.changed" && invalidation.bookId === selection.bookId && invalidation.contactId === selection.contactId) {
    return ["notes"];
  }
  return [];
};

export const dispatchContactsLiveInvalidation = async (invalidation: ContactLiveEvent, selection: ContactsLiveSelection): Promise<void> => {
  const pending = new Map<ContactsLiveOwner, Promise<void>[]>();
  window.dispatchEvent(
    new CustomEvent<ContactsLiveInvalidationDispatch>(CONTACTS_LIVE_INVALIDATION_EVENT, {
      detail: {
        invalidation,
        cover: (owner, work) => pending.set(owner, [...(pending.get(owner) ?? []), work]),
      },
    }),
  );
  const requiredOwners = requiredContactsLiveOwners(invalidation, selection);
  const coverage = [...pending.values()].flat();
  for (const owner of requiredOwners) {
    if (!pending.has(owner)) coverage.push(Promise.reject(new Error(`Contacts live ${owner} coverage is not ready`)));
  }
  const results = await Promise.allSettled(coverage);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
};

export const listenForContactsLiveInvalidation = (
  owner: ContactsLiveOwner,
  listener: (event: ContactLiveEvent) => void | Promise<void>,
): (() => void) => {
  const handler = (event: Event) => {
    const dispatch = (event as CustomEvent<ContactsLiveInvalidationDispatch>).detail;
    try {
      const work = listener(dispatch.invalidation);
      if (work) dispatch.cover(owner, work);
    } catch (error) {
      dispatch.cover(owner, Promise.reject(error));
    }
  };
  window.addEventListener(CONTACTS_LIVE_INVALIDATION_EVENT, handler);
  return () => window.removeEventListener(CONTACTS_LIVE_INVALIDATION_EVENT, handler);
};

export const requiresContactsShellRefresh = (event: ContactLiveEvent): boolean =>
  event.type.startsWith("book.") || event.type === "access.changed" || event.type === "tags.changed";

export const requiresContactsResultsRefresh = (event: ContactLiveEvent): boolean =>
  event.type.startsWith("contact.") || event.type === "contacts.imported" || event.type === "contacts.changed";

/** Returns whether an open contact may have changed or become inaccessible. */
export const requiresSelectedContactRefresh = (event: ContactLiveEvent, bookId: string): boolean => {
  if (event.type === "notes.changed") return false;
  return event.bookId === bookId;
};
