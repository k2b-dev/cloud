import type { DropdownItem } from "@k2b/ui";
import type { MenuEntry, MenuItem } from "@k2b/ui/v2";
import type { Accessor, JSX } from "solid-js";

/**
 * Another presentation of the reply box's open draft, chosen by its host (the Mail v2 pilot). The composer keeps every
 * draft, save, lease, recipient, attachment, assistant and send rule and hands the frame the parts it already drew
 * (the recipient field, the text, the notices) plus the state and the deeds of its head and its bar. The frame only
 * places them; it never sends, saves or decides on its own. Without a frame the box draws v1, unchanged.
 */
export type MailReplyFrame = {
  render: (parts: MailReplyFrameParts) => JSX.Element;
  /** The words in the empty text, the same as the resting composer's, so opening changes nothing but the caret. */
  placeholder: () => string;
  /** Stands in the box's place while its draft loads: the resting composer, so the thread below never moves. */
  pending?: () => JSX.Element;
};

/** A menu the frame opens from its own button; the entries are the composer's or the box's. */
export type MailReplyFrameMenu = { label: () => string; items: () => MenuEntry[]; disabled?: () => boolean };

/**
 * A choice of one behind a button (the reply's mode, its sender, its signature): the frame draws it as one v2 choice
 * under its own heading, ticks `value` and closes on a choice. Each option's `value` is what `choose` receives.
 */
export type MailReplyFrameChoice = {
  label: () => string;
  value: () => string;
  options: () => MenuItem[];
  choose: (value: string) => void;
  disabled?: () => boolean;
};

const menuItem = (item: Exclude<DropdownItem, { items: unknown }>): MenuItem => ({
  label: item.label,
  icon: item.icon?.replace(/^ti\s+/, "").replace(/^ti-/, ""),
  disabled: item.disabled,
  danger: item.variant === "danger",
  meta: item.description,
  // a toggle of the composer (preview, plain text, subject) stays a tick that keeps the menu open
  ...("choice" in item ? { checked: typeof item.checked === "function" ? item.checked() : item.checked } : {}),
  ...(item.action ? { onClick: item.action } : {}),
  ...(item.href ? { href: item.href } : {}),
});

/**
 * The composer's menus, which v1 draws as `Dropdown` entries, as entries of a v2 `Menu`: a section with a label is a
 * section under that heading, one without stands between lines, a description is the entry's quiet hint.
 */
export const frameMenuEntries = (items: readonly DropdownItem[]): MenuEntry[] =>
  items.flatMap((item): MenuEntry[] =>
    !("items" in item)
      ? [menuItem(item)]
      : item.sectionLabel
        ? [{ title: item.sectionLabel, items: item.items.map(menuItem) }]
        : ["separator", ...item.items.map(menuItem), "separator"],
  );

export type MailReplyFrameParts = {
  /** What is being written, for assistive technology, such as "Reply". */
  label: () => string;
  editable: Accessor<boolean>;
  /** Reply, Reply all, Forward or the internal note: the arrow at the start of the head. */
  mode: MailReplyFrameChoice & { icon: () => string };
  /** The To field: the recipients as removable chips, typed addresses and suggestions. */
  to: JSX.Element;
  /** The sender the reply goes out from; its menu when more than one verified sender can send. */
  sender: () => { text: string; choice: MailReplyFrameChoice | null } | null;
  /** Someone else writing along in a shared draft. */
  peers: JSX.Element;
  ccShown: Accessor<boolean>;
  showCc: () => void;
  /** The lines above the text: a suggestion, one-time lines, Cc and Bcc, the subject, and why the draft waits. */
  top: JSX.Element;
  /** The text with its attachments, signature and quote, as one scrolling surface. */
  body: JSX.Element;
  /** Where a shared draft says why Send waits, right above the bar. */
  hint: JSX.Element;
  tools: {
    /** Formatting is offered for Markdown text only. */
    formatting: () => { pressed: boolean; disabled: boolean; toggle: () => void; label: string } | null;
    attach: { label: () => string; disabled: () => boolean; run: () => void };
    signature: () => MailReplyFrameChoice | null;
    assistant: { label: () => string; disabled: () => boolean; run: () => void };
    /** Link, emoji, image, preview, quote, calendar, delivery options, plain text, subject, write large, window, later. */
    more: MailReplyFrameMenu;
  };
  /** What happens to the text right now (saving, saved, offline, uploading), at its fixed place; a phone shows the symbol. */
  status: JSX.Element;
  discard: { label: () => string; disabled: () => boolean; run: () => void };
  send: {
    label: () => string;
    /** The same Send as v1's, with every review and guard; after a failure it repeats the failed delivery. */
    run: () => void;
    busy: () => boolean;
    disabled: () => boolean;
    /** Why Send waits, said where Send is. */
    blocked: () => string | null;
  };
};
