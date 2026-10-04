/** A root `width` or `height` in plain pixels; percentages and other units do not give the drawing's extent. */
const pixels = (attributes: string, name: "width" | "height"): number | undefined => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attributes);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
  return value && /^\d+(?:\.\d+)?(?:px)?$/i.test(value) ? Number.parseFloat(value) : undefined;
};

/**
 * Gives an SVG root the target size, so the vector renders sharp instead of being scaled as a bitmap. Without a
 * viewBox, a new size would crop instead of scale, so the root gets one from its pixel size; a root with neither
 * stays as it is.
 */
export const sizedSvg = (svg: string, size: number): string =>
  svg.replace(/<svg\b([^>]*)>/i, (tag, attributes: string) => {
    const viewBox = /\sviewBox\s*=/i.test(attributes);
    const width = pixels(attributes, "width");
    const height = pixels(attributes, "height");
    if (!viewBox && (width === undefined || height === undefined)) return tag;
    let rest = attributes.replace(/\s(?:width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    if (!viewBox) rest += ` viewBox="0 0 ${width} ${height}"`;
    return `<svg${rest} width="${size}" height="${size}">`;
  });
