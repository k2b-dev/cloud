/**
 * A signature as the field reports it. `kind` records how it was given, so the
 * application can keep that fact next to the image. `svg` is a standalone SVG
 * document whose ink uses `currentColor`, so it follows the surrounding text
 * colour inline and renders black as an image.
 */
export type SignatureValue = { kind: "drawn"; svg: string } | { kind: "typed"; name: string; svg: string };

/** One sampled pointer position in drawing units, with a pressure from 0 to 1. */
export type SignaturePoint = { x: number; y: number; pressure: number };

/** The drawing space and one closed outline path per stroke. */
export type SignatureDrawing = { width: number; height: number; strokes: readonly string[] };

const SVG_NS = "http://www.w3.org/2000/svg";
/** Typed names are laid out at this size; the SVG scales as a whole. */
const TYPED_FONT_SIZE = 48;
const TYPED_PADDING = 12;

const round = (value: number) => Math.round(value * 10) / 10;
const point = (x: number, y: number) => `${round(x)} ${round(y)}`;

export const escapeXml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char] ?? char);

/** Stroke width in drawing units at a pressure: light pressure still leaves a readable line. */
export const strokeWidth = (size: number, pressure: number): number => size * (0.35 + 0.65 * Math.min(1, Math.max(0, pressure)));

/**
 * Turns sampled points into one filled outline: both edges follow the points at
 * half the local stroke width and are smoothed through their midpoints, and
 * round caps close the ends. A filled outline, unlike a stroked path, can change
 * width along the line, so pen pressure and drawing speed show in the ink.
 */
export const strokeOutline = (points: readonly SignaturePoint[], size: number): string => {
  const first = points[0];
  if (!first) return "";
  if (points.length === 1) {
    const radius = round(strokeWidth(size, first.pressure) / 2);
    const arc = (x: number) => `A${radius} ${radius} 0 1 0 ${point(x, first.y)}`;
    return `M${point(first.x - radius, first.y)}${arc(first.x + radius)}${arc(first.x - radius)}Z`;
  }
  type Edge = { x: number; y: number; radius: number };
  const left: Edge[] = [];
  const right: Edge[] = [];
  points.forEach((current, index) => {
    const before = points[index - 1] ?? current;
    const after = points[index + 1] ?? current;
    const dx = after.x - before.x;
    const dy = after.y - before.y;
    const length = Math.hypot(dx, dy) || 1;
    const radius = strokeWidth(size, current.pressure) / 2;
    const nx = (-dy / length) * radius;
    const ny = (dx / length) * radius;
    left.push({ x: current.x + nx, y: current.y + ny, radius });
    right.push({ x: current.x - nx, y: current.y - ny, radius });
  });
  right.reverse();
  // Quadratic segments through the midpoints of neighbouring edge points keep the outline smooth without overshoot.
  const edge = (side: readonly Edge[]) =>
    side
      .map((current, index) => {
        if (index === 0) return "";
        const next = side[index + 1];
        if (!next) return `L${point(current.x, current.y)}`;
        return `Q${point(current.x, current.y)} ${point((current.x + next.x) / 2, (current.y + next.y) / 2)}`;
      })
      .join("");
  const cap = (from: Edge, to: Edge) => `A${round(from.radius)} ${round(from.radius)} 0 0 0 ${point(to.x, to.y)}`;
  const start = left[0] ?? right[0];
  const end = left[left.length - 1];
  const back = right[0];
  const backEnd = right[right.length - 1];
  if (!start || !end || !back || !backEnd) return "";
  return `M${point(start.x, start.y)}${edge(left)}${cap(end, back)}${edge(right)}${cap(backEnd, start)}Z`;
};

/** Serializes a drawing as a standalone SVG document; an empty drawing has no value. */
export const drawingToSvg = (drawing: SignatureDrawing): string | null => {
  if (drawing.strokes.length === 0) return null;
  const width = round(drawing.width);
  const height = round(drawing.height);
  const paths = drawing.strokes.map((stroke) => `<path d="${escapeXml(stroke)}"/>`).join("");
  return `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><g fill="currentColor">${paths}</g></svg>`;
};

/** Reads the drawing space and strokes back from an SVG this module wrote, so a stored signature can be extended or undone. */
export const svgToDrawing = (svg: string): SignatureDrawing | null => {
  const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  if (!viewBox) return null;
  const strokes = [...svg.matchAll(/<path d="([^"]*)"/g)].flatMap((match) => (match[1] ? [match[1]] : []));
  return { width: Number(viewBox[1]), height: Number(viewBox[2]), strokes };
};

/**
 * Lays out a typed name as an SVG document in the given font family. `measure`
 * returns the text width at `TYPED_FONT_SIZE`; without one, the width is estimated.
 */
export const typedToSvg = (name: string, fontFamily: string, measure?: (text: string, font: string) => number | undefined): string => {
  const font = `${TYPED_FONT_SIZE}px ${fontFamily}`;
  const textWidth = measure?.(name, font) ?? name.length * TYPED_FONT_SIZE * 0.5;
  const width = Math.ceil(textWidth + TYPED_PADDING * 2);
  const height = Math.ceil(TYPED_FONT_SIZE * 1.6);
  const baseline = Math.round(TYPED_FONT_SIZE * 1.15);
  return (
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<text x="${TYPED_PADDING}" y="${baseline}" font-family="${escapeXml(fontFamily)}" font-size="${TYPED_FONT_SIZE}" fill="currentColor">${escapeXml(name)}</text></svg>`
  );
};

export type SignaturePngOptions = {
  /** Device pixels per SVG unit. Defaults to `2`. */
  scale?: number;
  /** Ink colour. Defaults to `"#000000"`. */
  color?: string;
  /** Background fill. Defaults to transparent. */
  background?: string;
};

/**
 * Rasterizes a signature into a PNG data URL in the browser, for a document or
 * service that needs a bitmap. A typed signature renders with the fonts
 * installed on this device: an SVG image cannot use the page's web fonts.
 */
export const signatureToPng = async (value: SignatureValue, options: SignaturePngOptions = {}): Promise<string> => {
  const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(value.svg);
  if (!viewBox) throw new Error("The signature SVG has no drawing size.");
  const scale = options.scale ?? 2;
  const width = Math.max(1, Math.round(Number(viewBox[1]) * scale));
  const height = Math.max(1, Math.round(Number(viewBox[2]) * scale));
  const svg = value.svg.replace("<svg ", `<svg color="${escapeXml(options.color ?? "#000000")}" `);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot draw a signature image.");
  if (options.background) {
    context.fillStyle = options.background;
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png");
};
