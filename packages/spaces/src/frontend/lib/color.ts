/** A stored colour as the Spaces contract holds it (`#rgb` or `#rrggbb`), else nothing: a style takes only a colour. */
export const hexColor = (value: string | null | undefined): string | undefined => {
  const color = value?.trim();
  return color && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : undefined;
};
