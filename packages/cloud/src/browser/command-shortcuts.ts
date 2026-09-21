import { COMMANDS_CHANGED, type ContextAwareCommand, collectContextAwareCommands } from "./command-bridge";

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const modifiers = ["ctrl", "alt", "shift", "meta"] as const;
type Combination = { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };

const parse = (shortcut: string): Combination | undefined => {
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.pop();
  if (!key || parts.some((part) => !["mod", ...modifiers].includes(part))) return;
  const keys = new Set(parts.map((part) => (part === "mod" ? (isMac() ? "meta" : "ctrl") : part)));
  return { key, ctrl: keys.has("ctrl"), alt: keys.has("alt"), shift: keys.has("shift"), meta: keys.has("meta") };
};
const signature = (shortcut: string) => {
  const parsed = parse(shortcut);
  return parsed && JSON.stringify(parsed);
};

/** Shared projection for the dispatcher, palette and Help. Conflicts never choose a winner. */
export const contextCommandsWithShortcuts = (): ContextAwareCommand[] => {
  const commands = collectContextAwareCommands();
  const keys = commands.map((command) => (command.shortcut ? signature(command.shortcut) : undefined));
  return commands.map((command, index) => ({
    ...command,
    shortcut: keys[index] && keys.filter((key) => key === keys[index]).length === 1 ? command.shortcut : undefined,
  }));
};

export const shortcutLabel = (shortcut: string): string => {
  const combination = parse(shortcut);
  if (!combination) return "";
  const mac = isMac();
  const names = { ctrl: mac ? "⌃" : "Ctrl", alt: mac ? "⌥" : "Alt", shift: mac ? "⇧" : "Shift", meta: mac ? "⌘" : "Meta" };
  return [...modifiers.filter((key) => combination[key]).map((key) => names[key]), combination.key.toUpperCase()].join(mac ? "" : "+");
};

/** One owner in the Cloud layout; app islands only publish commands. */
export const attachCommandShortcuts = (run: (command: ContextAwareCommand) => void): (() => void) => {
  const listener = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.isComposing || (!isMac() && event.getModifierState("AltGraph"))) return;
    const target = event.target;
    const editing =
      target instanceof Element &&
      Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]"));
    const dialogOpen = Boolean(document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]'));
    const matches = contextCommandsWithShortcuts().filter((command) => {
      if (!command.shortcut) return false;
      if (command.id !== "cloud.search" && dialogOpen) return false;
      const combo = parse(command.shortcut);
      if (!combo || (editing && !combo.ctrl && !combo.meta)) return false;
      // Shift+/ reports '?' on common keyboard layouts.
      const key = event.key === "?" && combo.key === "/" ? "/" : event.key.toLowerCase();
      const physicalLetter =
        combo.alt &&
        (event.key === "Dead" || !/^[a-z]$/i.test(event.key)) &&
        /^[a-z]$/.test(combo.key) &&
        event.code === `Key${combo.key.toUpperCase()}`;
      return (
        (key === combo.key || physicalLetter) &&
        event.ctrlKey === combo.ctrl &&
        event.altKey === combo.alt &&
        event.shiftKey === combo.shift &&
        event.metaKey === combo.meta
      );
    });
    if (matches.length !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    run(matches[0]!);
  };
  // Registered app combinations must win over editor bindings such as Mod+Shift+K.
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
};

export { COMMANDS_CHANGED };
