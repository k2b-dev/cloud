import { type DetailSelectPayload, detailPanel } from "@k2b/stdlib/solid";
import type { Contact } from "../../service";

export const CONTACT_DETAIL_EVENT = "contacts-detail-select";
export const CONTACT_NOTE_COMPOSE_EVENT = "contacts:note-compose";
export const shouldHandleContactDetailClick = detailPanel.shouldHandleClick;

export type ContactDetailPayload = DetailSelectPayload<Contact> & {
  bookId: string | null;
  favorite?: boolean;
};

type TransitionDoc = Document & {
  startViewTransition?: (callback: () => void) => void;
};

const withViewTransition = (callback: () => void) => {
  const doc = document as TransitionDoc;
  if (doc.startViewTransition) {
    doc.startViewTransition(callback);
    return;
  }
  callback();
};

/** Reads selected contact identifiers from URL query params. */
export const getSelectedContactFromUrl = () => ({
  contactId: detailPanel.getUrlParam("contact"),
  bookId: detailPanel.getUrlParam("contactBook"),
});

/** Dispatches detail selection updates to all listening contacts islands. */
const dispatchContactDetailSelect = (contact: Contact | null, contactId: string | null, bookId: string | null, favorite?: boolean) => {
  window.dispatchEvent(
    new CustomEvent(CONTACT_DETAIL_EVENT, {
      detail: {
        item: contact,
        itemKey: contactId,
        bookId,
        favorite,
      } as ContactDetailPayload,
    }),
  );
};

/** Reconciles mounted list/detail islands after another owner commits the URL. */
export const syncContactDetailFromUrl = () => {
  const selected = getSelectedContactFromUrl();
  dispatchContactDetailSelect(null, selected.contactId, selected.bookId);
};

type ContactHistoryMode = "push" | "replace";

const CONTACT_SELECTION_STATE = "contacts.selection";
let selectionDocumentId: string | undefined;

const selectionDepth = (state: unknown): number | undefined => {
  if (!selectionDocumentId || !state || typeof state !== "object" || !(CONTACT_SELECTION_STATE in state)) return;
  const marker = state[CONTACT_SELECTION_STATE];
  if (
    marker &&
    typeof marker === "object" &&
    "doc" in marker &&
    marker.doc === selectionDocumentId &&
    "depth" in marker &&
    typeof marker.depth === "number" &&
    Number.isSafeInteger(marker.depth) &&
    marker.depth > 0
  )
    return marker.depth;
};

/** A reloaded or directly linked selection has no matching marker in this document. */
export const backFromContactDetail = () => {
  const depth = selectionDepth(history.state);
  if (depth !== undefined) history.go(-depth);
  else clearSelectedContactInUrl("replace");
};

const commitSelectedContactUrl = (contactId: string | null, bookId: string | null, historyMode: ContactHistoryMode) => {
  const url = new URL(window.location.href);
  const hadSelection = url.searchParams.has("contact");
  if (contactId) {
    url.searchParams.set("contact", contactId);
  } else {
    url.searchParams.delete("contact");
  }
  if (bookId) {
    url.searchParams.set("contactBook", bookId);
  } else {
    url.searchParams.delete("contactBook");
  }
  if (url.toString() !== window.location.href) {
    const previousState: unknown = history.state;
    const state: Record<string, unknown> = { ...(previousState && typeof previousState === "object" ? previousState : {}) };
    if (historyMode === "push" && contactId) {
      const depth = hadSelection ? selectionDepth(previousState) : 0;
      if (depth !== undefined) {
        selectionDocumentId ??= crypto.randomUUID();
        state[CONTACT_SELECTION_STATE] = { doc: selectionDocumentId, depth: depth + 1 };
      } else delete state[CONTACT_SELECTION_STATE];
    } else if (!contactId) delete state[CONTACT_SELECTION_STATE];
    history[historyMode === "replace" ? "replaceState" : "pushState"](state, "", url.toString());
  }
};

/** Updates detail params without navigation and notifies detail/list islands. */
export const setSelectedContactInUrl = (config: {
  contactId: string | null;
  bookId: string | null;
  contact?: Contact | null;
  favorite?: boolean;
  history?: ContactHistoryMode;
}) => {
  withViewTransition(() => {
    commitSelectedContactUrl(config.contactId, config.bookId, config.history ?? "push");
    dispatchContactDetailSelect(config.contact ?? null, config.contactId, config.bookId, config.favorite);
  });
};

/** Clears selected contact params from URL and closes the detail panel. */
export const clearSelectedContactInUrl = (history: ContactHistoryMode = "push") => {
  setSelectedContactInUrl({ contactId: null, bookId: null, contact: null, history });
};

/** Opens the comments composer in the currently mounted detail panel. */
export const requestContactNoteComposer = (contactId: string) => {
  window.dispatchEvent(new CustomEvent(CONTACT_NOTE_COMPOSE_EVENT, { detail: { contactId } }));
};
