import { keyboardPlatform } from "@k2b/ui";
import { COMMANDS_CHANGED, type ContextAwareCommand, collectContextAwareCommands } from "./command-bridge";

const isMac = () => keyboardPlatform() === "apple";
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

const ARROWS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright"]);

/**
 * One owner in the Cloud layout; app islands only publish commands. A command
 * on an arrow key comes last: the focused element sees the key first, and a
 * widget that moves with arrow keys, such as a tree that reorders on Alt+↑ or
 * an open list, keeps it by handling it.
 */
export const attachCommandShortcuts = (run: (command: ContextAwareCommand) => void): (() => void) => {
  const listener = (event: KeyboardEvent, arrows: boolean) => {
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
      if (!combo || ARROWS.has(combo.key) !== arrows || (editing && !combo.ctrl && !combo.meta)) return false;
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
  const first = (event: KeyboardEvent) => listener(event, false);
  const last = (event: KeyboardEvent) => listener(event, true);
  window.addEventListener("keydown", first, true);
  window.addEventListener("keydown", last);
  return () => {
    window.removeEventListener("keydown", first, true);
    window.removeEventListener("keydown", last);
  };
};

export { COMMANDS_CHANGED };
