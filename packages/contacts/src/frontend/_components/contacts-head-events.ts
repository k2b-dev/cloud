export const CONTACTS_HEAD_STATE_EVENT = "contacts-head-state";
const CONTACTS_HEAD_REQUEST_EVENT = "contacts-head-request";
const CONTACTS_HEAD_CHANGE_EVENT = "contacts-head-change";
const CONTACTS_HEAD_SUPERSEDE_EVENT = "contacts-head-supersede";
const CONTACTS_SELECTION_MODE_EVENT = "contacts-selection-mode";

export type ContactsHeadState = {
  source: string;
  requestedSource: string;
  busy: boolean;
  total: number;
  filtered: boolean;
  selectionMode: boolean;
};
export type ContactsHeadChange = { href: string; resetSearch?: boolean };

export const publishContactsHeadState = (state: ContactsHeadState) => {
  window.dispatchEvent(new CustomEvent<ContactsHeadState>(CONTACTS_HEAD_STATE_EVENT, { detail: state }));
};

/** Results owns requests, history, selection, recovery, and the authoritative snapshot. */
export const subscribeToContactsHeadChanges = (
  change: (change: ContactsHeadChange) => void,
  toggleSelection: () => void,
  publish: () => void,
  supersede: () => void,
) => {
  const onChange = (event: Event) => {
    if (event instanceof CustomEvent) change(event.detail);
  };
  window.addEventListener(CONTACTS_HEAD_CHANGE_EVENT, onChange);
  window.addEventListener(CONTACTS_SELECTION_MODE_EVENT, toggleSelection);
  window.addEventListener(CONTACTS_HEAD_REQUEST_EVENT, publish);
  window.addEventListener(CONTACTS_HEAD_SUPERSEDE_EVENT, supersede);
  return () => {
    window.removeEventListener(CONTACTS_HEAD_CHANGE_EVENT, onChange);
    window.removeEventListener(CONTACTS_SELECTION_MODE_EVENT, toggleSelection);
    window.removeEventListener(CONTACTS_HEAD_REQUEST_EVENT, publish);
    window.removeEventListener(CONTACTS_HEAD_SUPERSEDE_EVENT, supersede);
  };
};

/** Subscribe before requesting the current snapshot; hydration order is immaterial. */
export const connectContactsHead = (receive: (state: ContactsHeadState) => void) => {
  let ready = false;
  const onState = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    ready = true;
    receive(event.detail);
  };
  window.addEventListener(CONTACTS_HEAD_STATE_EVENT, onState);
  window.dispatchEvent(new CustomEvent(CONTACTS_HEAD_REQUEST_EVENT));
  return {
    change: (change: ContactsHeadChange) => {
      if (!ready) window.location.assign(change.href);
      else window.dispatchEvent(new CustomEvent<ContactsHeadChange>(CONTACTS_HEAD_CHANGE_EVENT, { detail: change }));
    },
    supersede: () => {
      if (ready) window.dispatchEvent(new CustomEvent(CONTACTS_HEAD_SUPERSEDE_EVENT));
    },
    toggleSelection: () => window.dispatchEvent(new CustomEvent(CONTACTS_SELECTION_MODE_EVENT)),
    dispose: () => window.removeEventListener(CONTACTS_HEAD_STATE_EVENT, onState),
  };
};

export const plainContactsClick = (event: MouseEvent) =>
  !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
