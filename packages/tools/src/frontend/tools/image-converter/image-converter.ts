export type ImageConverterFormat = "jpeg" | "png" | "webp";
export type ImageConverterRotation = 0 | 90 | 180 | 270;

export type ImageDimensions = {
  width: number;
  height: number;
};

export const rotatedDimensions = (width: number, height: number, rotation: ImageConverterRotation): ImageDimensions =>
  rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };

export const fitWithin = (width: number, height: number, maxWidth: number | null, maxHeight: number | null): ImageDimensions => {
  const widthLimit = maxWidth && maxWidth > 0 ? maxWidth : Number.POSITIVE_INFINITY;
  const heightLimit = maxHeight && maxHeight > 0 ? maxHeight : Number.POSITIVE_INFINITY;
  const scale = Math.min(widthLimit / width, heightLimit / height, 1);

  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
};

const extensionFor = (format: ImageConverterFormat): string => (format === "jpeg" ? "jpg" : format);

const filenameStem = (filename: string): string => {
  const basename = filename.split(/[\\/]/u).at(-1)?.trim() || "image";
  return basename.replace(/\.[^.]+$/u, "").trim() || "image";
};

const safeStem = (filename: string): string => filenameStem(filename).replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-");

export const uniqueOutputNames = (filenames: readonly string[], format: ImageConverterFormat): string[] => {
  const extension = extensionFor(format);
  const used = new Set<string>();

  return filenames.map((filename) => {
    const stem = safeStem(filename);
    let suffix = 1;
    let candidate = `${stem}.${extension}`;
    while (used.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${stem}-${suffix}.${extension}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
};

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const buildBase64ImageTag = (dataUrl: string, filename: string, dimensions: ImageDimensions): string =>
  `<img src="${escapeAttribute(dataUrl)}" alt="${escapeAttribute(filenameStem(filename))}" width="${dimensions.width}" height="${dimensions.height}">`;

export const nextClockwiseRotation = (rotation: ImageConverterRotation): ImageConverterRotation => {
  if (rotation === 0) return 90;
  if (rotation === 90) return 180;
  if (rotation === 180) return 270;
  return 0;
};
