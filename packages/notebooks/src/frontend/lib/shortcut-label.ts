import { formatShortcut, keyboardPlatform } from "@k2b/ui";

/** Apple keyboards name the platform modifier Command; everyone else uses Control. */
export const isApple = () => keyboardPlatform() === "apple";

/** Converts the editor's dash-separated shortcut to the shared key names. */
export const shortcutLabel = (keys: string, locale?: string) => {
  const minus = keys === "-" || keys.endsWith("--");
  const parts = (minus ? keys.slice(0, -1) : keys).split("-");
  if (minus) parts.pop();
  const key = minus ? "-" : parts.pop();
  return formatShortcut([...parts, key ?? ""].join("+"), { locale }).label;
};

/** The same keys in `aria-keyshortcuts` syntax, such as `Meta+Shift+2`. */
export const ariaShortcut = (keys: string) =>
  keys
    .split("-")
    .map((part) =>
      part === "Mod" ? (isApple() ? "Meta" : "Control") : part === "Ctrl" ? "Control" : part.length === 1 ? part.toUpperCase() : part,
    )
    .join("+");
