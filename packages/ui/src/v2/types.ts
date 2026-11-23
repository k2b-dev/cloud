/**
 * Opens a link's page in place, beside the real link (`href`): it is called on a plain click of the link (the main
 * button without a modifier key, also Enter on the focused link) and opens the page in place when it calls
 * `event.preventDefault()`; without that call the browser follows the link. A click with a modifier key or the middle
 * button, a link with another target, and "open in new tab" never reach it, and before the page is live the link
 * works on its own.
 */
export type OnNavigate = (event: MouseEvent) => void;

/** A click that the page may take over: the main button, no modifier key, not taken yet, no other target (internal). */
const isPlainClick = (event: MouseEvent) => {
  const link = event.currentTarget;
  const elsewhere = link instanceof HTMLAnchorElement && ((link.target !== "" && link.target !== "_self") || link.hasAttribute("download"));
  return (
    !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && !elsewhere
  );
};

/** Hands a click of a link to its `onNavigate` when it is a plain click (internal to the primitives). */
export const navigate = (onNavigate: OnNavigate | undefined, event: MouseEvent) => {
  if (onNavigate && isPlainClick(event)) onNavigate(event);
};

/** The width of a column that can be dragged: its minimum and its default, in CSS px. Nothing else. */
export type Width = { min: number; default: number };

/**
 * An action as data. The primitive decides whether it becomes a button, an icon button or a text button, so the
 * same action looks the same in every place (concept, API style).
 */
export type Action = {
  label: string;
  /** A Tabler icon name without the `ti-` prefix, such as `plus`. */
  icon?: string;
  href?: string;
  /** With `href`: opens the page in place on a plain click (see `OnNavigate`). */
  onNavigate?: OnNavigate;
  onClick?: () => void;
  /** A quiet summary after the label where the place shows one, such as "Bank, Person, Portal". */
  meta?: string;
  /** The action leads further, to a page with more: a chevron to the right after the label. */
  forward?: boolean;
};

/** At most two actions, such as the text buttons in the head of a section; a third does not fit by type. */
export type TwoActions = readonly [Action] | readonly [Action, Action];

/** The colours of meaning. A tone is never decoration: it says ok, wait, wrong, AI or "yours". */
export type Status = "ok" | "warn" | "bad";

/** A person or an organisation shown as initials on a colour. */
export type Person = { name: string; initials?: string; color?: string };

/** The initials of a name: the first letters of its first two words. */
export const initialsOf = (person: Person): string =>
  person.initials ??
  person.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
