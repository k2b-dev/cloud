import { resolveShortcutMessages } from "./shortcut-messages";

export type KeyboardPlatform = "apple" | "other";
/**
 * Apple keyboards name the platform modifier Command. `source` is a User-Agent or `navigator.platform` string.
 * Without `source`, reads the runtime's navigator; server callers pass the request's User-Agent.
 * @example keyboardPlatform("MacIntel") // "apple"
 */
export const keyboardPlatform = (source?: string): KeyboardPlatform =>
  /Mac|iPhone|iPad|iPod/.test(source ?? (typeof navigator === "undefined" ? "" : navigator.platform || navigator.userAgent))
    ? "apple"
    : "other";

export type ShortcutKey = {
  /** What the cap shows: "⌘", "Strg", "K", "↵". */
  label: string;
  /** What a screen reader says: "Command", "Steuerung", "K", "Enter". */
  name: string;
};
export type FormattedShortcut = {
  keys: ShortcutKey[];
  /** "⌘K" on Apple, "Ctrl+K" / "Strg+K" elsewhere. */
  label: string;
  /** "Command K", "Steuerung K". */
  name: string;
};
export type ShortcutFormatOptions = { platform?: KeyboardPlatform; locale?: string };
const modifiers = ["ctrl", "alt", "shift", "meta"] as const;

/**
 * Formats one plus-separated shortcut in canonical modifier order.
 * @example formatShortcut("mod+alt+n", { platform: "apple" }).label // "⌥⌘N"
 */
export const formatShortcut = (shortcut: string, options: ShortcutFormatOptions = {}): FormattedShortcut => {
  const empty = { keys: [], label: "", name: "" };
  const input = shortcut.trim().toLowerCase();
  const plus = input === "+" || input.endsWith("++");
  const parts = (plus ? input.slice(0, -1) : input).split("+");
  const key = plus ? "+" : parts.pop() || (shortcut === " " || shortcut.endsWith("+ ") ? "space" : undefined);
  if (plus) parts.pop();
  if (
    !key ||
    modifiers.some((modifier) => key === modifier) ||
    key === "mod" ||
    parts.some((part) => part !== "mod" && !modifiers.some((modifier) => part === modifier))
  )
    return empty;
  const apple = (options.platform ?? keyboardPlatform()) === "apple";
  const t = resolveShortcutMessages(options.locale);
  const selected = new Set(parts.map((part) => (part === "mod" ? (apple ? "meta" : "ctrl") : part)));
  const labels = apple
    ? { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" }
    : { ctrl: t.ctrlLabel, alt: t.altLabel, shift: t.shiftLabel, meta: t.metaLabel };
  const names = {
    ctrl: apple ? t.appleControl : t.control,
    alt: apple ? t.option : t.alt,
    shift: t.shift,
    meta: apple ? t.command : t.meta,
  };
  const named: Record<string, ShortcutKey> = {
    arrowup: { label: "↑", name: t.arrowup },
    arrowdown: { label: "↓", name: t.arrowdown },
    arrowleft: { label: "←", name: t.arrowleft },
    arrowright: { label: "→", name: t.arrowright },
    enter: { label: "↵", name: t.enter },
    escape: { label: "Esc", name: t.escape },
    esc: { label: "Esc", name: t.escape },
    tab: { label: "Tab", name: t.tab },
    space: { label: t.spaceLabel, name: t.space },
    backspace: { label: "⌫", name: t.backspace },
    delete: { label: apple ? "⌦" : t.deleteLabel, name: t.delete },
    home: { label: t.homeLabel, name: t.home },
    end: { label: t.endLabel, name: t.end },
    pageup: { label: t.pageupLabel, name: t.pageup },
    pagedown: { label: t.pagedownLabel, name: t.pagedown },
  };
  const label = key.length === 1 || /^f(?:[1-9]|1[0-2])$/.test(key) ? key.toUpperCase() : key[0]!.toUpperCase() + key.slice(1);
  const namedKey = Object.hasOwn(named, key) ? named[key] : undefined;
  const keys = [
    ...modifiers.filter((modifier) => selected.has(modifier)).map((modifier) => ({ label: labels[modifier], name: names[modifier] })),
    namedKey ?? { label, name: label },
  ];
  return { keys, label: keys.map((key) => key.label).join(apple ? "" : "+"), name: keys.map((key) => key.name).join(" ") };
};
