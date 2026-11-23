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
