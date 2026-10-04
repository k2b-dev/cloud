import type { ContactLiveEvent } from "../../live-events";

const CONTACTS_LIVE_INVALIDATION_EVENT = "contacts:live-invalidation";

type ContactsLiveInvalidation = ContactLiveEvent | { type: "scope.changed" };

type ContactsLiveOwner = "results" | "detail" | "notes";

type ContactsLiveSelection = {
  bookId: string | null;
  contactId: string | null;
};

type ContactsLiveInvalidationDispatch = {
  invalidation: ContactsLiveInvalidation;
  cover: (owner: ContactsLiveOwner, work: Promise<void>) => void;
};

type ContactsLiveApplyControls = {
  markApplied: (cursor: string) => void;
  terminate: (error: { code: string; message: string }) => void;
};

type ContactsLiveApplyQueueOptions = {
  apply: (event: ContactLiveEvent, controls: ContactsLiveApplyControls) => Promise<boolean | void>;
  onFailure: (error: unknown, controls: ContactsLiveApplyControls) => void | Promise<void>;
};

export const createContactsLiveApplyQueue = (options: ContactsLiveApplyQueueOptions) => {
  let queue = Promise.resolve();
  let stopped = false;

  const enqueue = (event: ContactLiveEvent, cursor: string, controls: ContactsLiveApplyControls): Promise<void> => {
    const apply = queue.then(async () => {
      if (stopped) return;
      const applied = await options.apply(event, controls);
      if (applied === false || stopped) {
        stopped = true;
        return;
      }
      controls.markApplied(cursor);
    });
    queue = apply.catch(async (error) => {
      if (stopped) return;
      stopped = true;
      await options.onFailure(error, controls);
    });
    return queue;
  };

  return {
    enqueue,
    stop: () => {
      stopped = true;
    },
  };
};

const requiredContactsLiveOwners = (invalidation: ContactsLiveInvalidation, selection: ContactsLiveSelection): ContactsLiveOwner[] => {
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

export const dispatchContactsLiveInvalidation = async (
  invalidation: ContactsLiveInvalidation,
  selection: ContactsLiveSelection,
): Promise<void> => {
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
  listener: (event: ContactsLiveInvalidation) => void | Promise<void>,
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

export const requiresContactsShellRefresh = (event: ContactsLiveInvalidation): boolean =>
  event.type === "scope.changed" || event.type.startsWith("book.") || event.type === "access.changed" || event.type === "tags.changed";

export const requiresContactsResultsRefresh = (event: ContactsLiveInvalidation): boolean =>
  event.type.startsWith("contact.") || event.type === "contacts.imported" || event.type === "contacts.changed";

/** Returns whether an open contact may have changed or become inaccessible. */
export const requiresSelectedContactRefresh = (event: ContactsLiveInvalidation, bookId: string): boolean => {
  if (event.type === "scope.changed") return true;
  if (event.type === "notes.changed") return false;
  return event.bookId === bookId;
};
