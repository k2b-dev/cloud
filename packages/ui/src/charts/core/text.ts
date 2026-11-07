/** Conservative proportional-font advances in em, shared by DOM-free SVG label layout.
 * Wide glyphs retain their natural shape; fitting removes whole code points instead of stretching text.
 */
export function chartTextWidth(text: string, size: number): number {
  return (
    Array.from(text).reduce(
      (width, glyph) =>
        width +
        (/\s/.test(glyph)
          ? 0.34
          : /[ilI.,:;!|'`]/.test(glyph)
            ? 0.32
            : /[MW@%&]/.test(glyph)
              ? 1
              : /[A-Z0-9]/.test(glyph)
                ? 0.74
                : /[a-zäöüßéèáàóúñç()-]/i.test(glyph)
                  ? 0.64
                  : 1),
      0,
    ) * size
  );
}

export function fitChartText(text: string, width: number, size: number): string {
  if (chartTextWidth(text, size) <= width) return text;
  const glyphs = Array.from(text);
  while (glyphs.length && chartTextWidth(glyphs.join("") + "…", size) > width) glyphs.pop();
  return chartTextWidth("…", size) <= width ? glyphs.join("") + "…" : "";
}
