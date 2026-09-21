import { replaceTextareaRange } from "../editor-dom";
import { insertLink, toggleBold, toggleBulletList, toggleCode, toggleHeading, toggleItalic, toggleNumberedList } from "./actions";

const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);

type EditorAction = (element: HTMLTextAreaElement) => void;

/** Keyed by `event.key.toLowerCase()`. A `Map` (not an object literal) so a
 *  key that collides with an `Object.prototype` member — `constructor`,
 *  `__proto__`, `valueOf`, … — resolves to "no shortcut" instead of picking
 *  up an inherited value and throwing inside the keydown handler. */
const INLINE_ACTIONS = new Map<string, EditorAction>([
  ["b", toggleBold],
  ["i", toggleItalic],
  ["e", toggleCode],
  ["k", insertLink],
]);

/** Keyed by `event.code` (layout-independent physical key), so Shift+1 maps
 *  to H1 on QWERTY, AZERTY and German layouts alike. Same `Map` rationale. */
const BLOCK_ACTIONS = new Map<string, EditorAction>([
  ["Digit1", (element) => toggleHeading(element, 1)],
  ["Digit2", (element) => toggleHeading(element, 2)],
  ["Digit3", (element) => toggleHeading(element, 3)],
  ["Digit7", toggleNumberedList],
  ["Digit8", toggleBulletList],
]);

export const handleShortcut = (event: KeyboardEvent, textarea: HTMLTextAreaElement): boolean => {
  if (event.isComposing || event.altKey) return false;
  if (!(isMac() ? event.metaKey : event.ctrlKey)) return false;
  const action = event.shiftKey ? BLOCK_ACTIONS.get(event.code) : INLINE_ACTIONS.get(event.key.toLowerCase());
  if (!action) return false;
  action(textarea);
  return true;
};

const LIST_RE = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/;

export const handleListContinuation = (textarea: HTMLTextAreaElement): boolean => {
  const { value, selectionStart, selectionEnd } = textarea;
  if (selectionStart !== selectionEnd) return false;
  const lineStart = value.lastIndexOf("\n", selectionStart - 1) + 1;
  const nextNewline = value.indexOf("\n", selectionStart);
  const lineEnd = nextNewline === -1 ? value.length : nextNewline;
  const match = LIST_RE.exec(value.slice(lineStart, lineEnd));
  if (!match) return false;

  const [, indent = "", marker = "-", spaces = " ", content = ""] = match;
  const markerEnd = lineStart + indent.length + marker.length + spaces.length;
  if (selectionStart < markerEnd) return false;
  if (content.trim() === "") {
    replaceTextareaRange(textarea, lineStart, lineEnd, "");
    return true;
  }
  const numbered = /^(\d+)\.$/.exec(marker);
  const nextMarker = numbered ? `${Number.parseInt(numbered[1]!, 10) + 1}.` : marker;
  replaceTextareaRange(textarea, selectionStart, selectionStart, `\n${indent}${nextMarker}${spaces}`);
  return true;
};

const URL_RE = /^https?:\/\/\S+$/;
const validUrl = (value: string): boolean => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

export const handleSmartPaste = (event: ClipboardEvent, textarea: HTMLTextAreaElement): boolean => {
  const value = event.clipboardData?.getData("text/plain").trim();
  if (!value || !URL_RE.test(value) || !validUrl(value) || textarea.selectionStart === textarea.selectionEnd) {
    return false;
  }
  insertLink(textarea, value.replace(/\(/g, "%28").replace(/\)/g, "%29"));
  return true;
};
