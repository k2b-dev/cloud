import type { LinkNavigateEvent } from "@k2b/ssr/nav";

/**
 * Opens a link's page in place, beside the real link (`href`): the contract of `@k2b/ssr/nav`'s `Link`, which the
 * primitive renders. A plain same-origin click (the main button, no modifier key, no other target) reaches it; the
 * link has then taken the click and cancelled a pending page swap, and the handler moves history with `push` or
 * `replaceWith`, or loads the page with `fallback`. A click with a modifier key, "open in new tab" and a click before
 * the page is live stay the browser's.
 */
export type OnNavigate = (event: LinkNavigateEvent) => void | Promise<void>;

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
export type Person = {
  name: string;
  initials?: string;
  /** The colour behind the initials; without it the fixed colour of the name, the same everywhere in Cloud. */
  color?: string;
};

/** The initials of a name: the first letters of its first two words. */
export const initialsOf = (person: Person): string =>
  person.initials ??
  person.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
