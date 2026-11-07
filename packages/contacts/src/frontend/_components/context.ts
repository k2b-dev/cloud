import { type DetailSelectPayload, detailPanel } from "@k2b/stdlib/solid";
import type { Contact } from "../../service";

export const CONTACT_DETAIL_EVENT = "contacts-detail-select";
export const CONTACT_NOTE_COMPOSE_EVENT = "contacts:note-compose";
export const shouldHandleContactDetailClick = detailPanel.shouldHandleClick;

export type ContactDetailPayload = DetailSelectPayload<Contact> & {
  bookId: string | null;
  favorite?: boolean;
  addressId?: string | null;
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
  addressId: detailPanel.getUrlParam("address"),
});

/** Dispatches detail selection updates to all listening contacts islands. */
const dispatchContactDetailSelect = (
  contact: Contact | null,
  contactId: string | null,
  bookId: string | null,
  favorite?: boolean,
  addressId?: string | null,
) => {
  window.dispatchEvent(
    new CustomEvent(CONTACT_DETAIL_EVENT, {
      detail: {
        item: contact,
        itemKey: contactId,
        bookId,
        favorite,
        addressId,
      } as ContactDetailPayload,
    }),
  );
};

/** Reconciles mounted list/detail islands after another owner commits the URL. */
export const syncContactDetailFromUrl = () => {
  const selected = getSelectedContactFromUrl();
  dispatchContactDetailSelect(null, selected.contactId, selected.bookId, undefined, selected.addressId);
};

type ContactHistoryMode = "push" | "replace";

const commitSelectedContactUrl = (
  contactId: string | null,
  bookId: string | null,
  historyMode: ContactHistoryMode,
  addressId?: string | null,
) => {
  const url = new URL(window.location.href);
  url.searchParams.delete("contactOutcome");
  if (contactId && bookId && addressId) url.searchParams.set("address", addressId);
  else url.searchParams.delete("address");
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
  if (url.toString() !== window.location.href) history[historyMode === "replace" ? "replaceState" : "pushState"]({}, "", url.toString());
};

/** Updates detail params without navigation and notifies detail/list islands. */
export const setSelectedContactInUrl = (config: {
  contactId: string | null;
  bookId: string | null;
  contact?: Contact | null;
  favorite?: boolean;
  history?: ContactHistoryMode;
  addressId?: string | null;
}) => {
  withViewTransition(() => {
    commitSelectedContactUrl(config.contactId, config.bookId, config.history ?? "push", config.addressId);
    dispatchContactDetailSelect(config.contact ?? null, config.contactId, config.bookId, config.favorite, config.addressId);
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
