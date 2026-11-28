import { personMarkColorOf } from "@k2b/ui";

/** A stored colour as the Notebooks contract holds it (`#rgb` or `#rrggbb`), else nothing: a style takes only a colour. */
export const hexColor = (value: string | null | undefined): string | undefined => {
  const color = value?.trim();
  return color && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : undefined;
};

/** A stored author color as a mark: only a hex is taken, and a person's hue gets its dark step (`light-dark()`). */
export const markColor = (value: string): string => {
  const hex = hexColor(value);
  return hex ? personMarkColorOf(hex) : "transparent";
};
