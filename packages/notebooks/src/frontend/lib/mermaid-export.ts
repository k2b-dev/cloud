import { mermaidConfig } from "@k2b/cloud/browser/mermaid";

/**
 * iOS Safari refuses canvases above 16,777,216 pixels (4096²), the smallest
 * limit among supported browsers, so the PNG scale shrinks to stay below it.
 */
const MAX_CANVAS_PIXELS = 16_777_216;

export type StandaloneSvg = { svg: string; width: number; height: number };

/**
 * Mermaid sizes its SVG relative to the page (`width="100%"`, `max-width`).
 * A downloaded file and a rasterized image need the intrinsic size from the
 * `viewBox` instead.
 */
export const standaloneSvg = (markup: string): StandaloneSvg => {
  const document = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || root.querySelector("parsererror")) throw new Error("Diagram is not an SVG document");
  const box = (root.getAttribute("viewBox") ?? "")
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  const width = Math.ceil(box[2] ?? 0);
  const height = Math.ceil(box[3] ?? 0);
  if (!(width > 0) || !(height > 0)) throw new Error("Diagram has no usable viewBox");
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  root.style.removeProperty("max-width");
  if (!root.getAttribute("style")?.trim()) root.removeAttribute("style");
  return { svg: new XMLSerializer().serializeToString(root), width, height };
};

/** The page background of the diagram's theme; exported PNGs are opaque. */
export const diagramBackground = (dark: boolean): string => {
  const background: unknown = mermaidConfig({ dark }).themeVariables?.background;
  return typeof background === "string" ? background : dark ? "#11151b" : "#ffffff";
};

export const pngScale = (width: number, height: number, devicePixelRatio: number): number =>
  Math.min(Math.max(2, devicePixelRatio), Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Diagram image could not be decoded"));
    image.src = url;
  });

/** Rasterize a standalone SVG through an image sink, so its markup never becomes live DOM. */
export const rasterizeSvg = async (diagram: StandaloneSvg, options: { background: string; scale: number }): Promise<Blob> => {
  const url = URL.createObjectURL(new Blob([diagram.svg], { type: "image/svg+xml" }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(diagram.width * options.scale));
    canvas.height = Math.max(1, Math.round(diagram.height * options.scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.fillStyle = options.background;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** File name base from the note title; `diagram` when the note has none. */
export const diagramFilename = (title: string | null | undefined): string =>
  (title ?? "")
    .replace(/[\r\n/:*?"<>|\\]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200) || "diagram";
