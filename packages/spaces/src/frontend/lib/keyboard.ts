export const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
};

export const isPlainShortcut = (event: KeyboardEvent, key: string): boolean =>
  !event.defaultPrevented &&
  !event.repeat &&
  !event.metaKey &&
  !event.ctrlKey &&
  !event.altKey &&
  !event.shiftKey &&
  event.key.toLowerCase() === key.toLowerCase() &&
  !isTypingTarget(event.target) &&
  !document.querySelector("dialog[open]");
