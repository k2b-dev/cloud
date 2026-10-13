/** Apple keyboards name the platform modifier Command; everyone else uses Control. */
export const isApple = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Use the platform's key names, so a tooltip matches the keyboard in front of the reader. */
export const shortcutLabel = (keys: string, names: { ctrl: string; shift: string; alt: string }) => {
  const parts = keys.split("-");
  const key = parts.pop()!.toUpperCase();
  if (isApple()) {
    return `${parts.includes("Ctrl") ? "⌃" : ""}${parts.includes("Alt") ? "⌥" : ""}${parts.includes("Shift") ? "⇧" : ""}${parts.includes("Mod") || parts.includes("Meta") ? "⌘" : ""}${key}`;
  }
  return [
    ...parts.map((part) =>
      part === "Mod" || part === "Ctrl" ? names.ctrl : part === "Shift" ? names.shift : part === "Alt" ? names.alt : part,
    ),
    key,
  ].join("+");
};

/** The same keys in `aria-keyshortcuts` syntax, such as `Meta+Shift+2`. */
export const ariaShortcut = (keys: string) =>
  keys
    .split("-")
    .map((part) =>
      part === "Mod" ? (isApple() ? "Meta" : "Control") : part === "Ctrl" ? "Control" : part.length === 1 ? part.toUpperCase() : part,
    )
    .join("+");
