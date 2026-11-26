import { type ImgData, images as imageTools } from "@k2b/stdlib/browser";
import { PREVIEW_MAX } from "./constants";
import { applyMarkupToImage } from "./markup";
import type { ImageEntry } from "./types";

/** The face of an image in the strip and the presets: a square cut from its middle, sharp on a dense screen. */
export const makeThumbnail = (preview: ImgData): Promise<string> =>
  imageTools.resize(96, 96, "cover")(preview).then(imageTools.toBase64("jpeg", 0.8));

export const rotatedImageDimensions = (width: number, height: number, degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  const normalizeTrig = (value: number) => {
    const absolute = Math.abs(value);
    if (absolute < 1e-12) return 0;
    if (Math.abs(1 - absolute) < 1e-12) return 1;
    return absolute;
  };
  const sin = normalizeTrig(Math.sin(radians));
  const cos = normalizeTrig(Math.cos(radians));
  return {
    width: Math.ceil(width * cos + height * sin),
    height: Math.ceil(width * sin + height * cos),
  };
};

const rotateImage = async (data: ImgData, degrees: number): Promise<ImgData> => {
  const dimensions = rotatedImageDimensions(data.width, data.height, degrees);
  const canvas = Object.assign(document.createElement("canvas"), dimensions);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create a canvas for image rotation");

  ctx.translate(dimensions.width / 2, dimensions.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(data.canvas, -data.width / 2, -data.height / 2);
  return { canvas, ctx, ...dimensions };
};

export const makePreviewSource = async (source: ImgData): Promise<ImgData> => {
  const maxDim = Math.max(source.width, source.height);
  if (maxDim <= PREVIEW_MAX) return source;

  const scale = PREVIEW_MAX / maxDim;
  return imageTools.resize(Math.round(source.width * scale), Math.round(source.height * scale), "fill")(source);
};

export const buildImagePipeline = (entry: ImageEntry, maxW?: number, maxH?: number) => {
  const a = entry.adj;
  let pipeline: Promise<ImgData> = Promise.resolve(entry.source);

  if (maxW || maxH) {
    pipeline = pipeline.then(async (data) => {
      const mw = maxW ?? Infinity;
      const mh = maxH ?? Infinity;
      if (data.width <= mw && data.height <= mh) return data;

      const scale = Math.min(mw / data.width, mh / data.height);
      return imageTools.resize(Math.round(data.width * scale), Math.round(data.height * scale), "fill")(data);
    });
  }

  const filterParts: string[] = [];
  if (a.brightness !== 1) filterParts.push(`brightness(${a.brightness})`);
  if (a.contrast !== 1) filterParts.push(`contrast(${a.contrast})`);
  if (a.saturation !== 1) filterParts.push(`saturate(${a.saturation})`);
  if (a.hueRotate !== 0) filterParts.push(`hue-rotate(${a.hueRotate}deg)`);
  if (a.blur > 0) filterParts.push(`blur(${a.blur}px)`);
  if (a.sepia > 0) filterParts.push(`sepia(${a.sepia})`);
  const filterStr = filterParts.join(" ");
  if (filterStr) {
    pipeline = pipeline.then(imageTools.filter(filterStr));
  }

  if (a.vignette > 0) {
    pipeline = pipeline.then(
      imageTools.apply((ctx, canvas) => {
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const r = Math.max(cx, cy);
        const grad = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r);
        grad.addColorStop(0, "transparent");
        grad.addColorStop(1, `rgba(0,0,0,${a.vignette})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }),
    );
  }

  if (a.grain > 0) {
    pipeline = pipeline.then(
      imageTools.apply((ctx, canvas) => {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const intensity = a.grain * 255;
        for (let i = 0; i < data.length; i += 4) {
          const noise = (Math.random() - 0.5) * intensity;
          data[i] = Math.min(255, Math.max(0, data[i]! + noise));
          data[i + 1] = Math.min(255, Math.max(0, data[i + 1]! + noise));
          data[i + 2] = Math.min(255, Math.max(0, data[i + 2]! + noise));
        }
        ctx.putImageData(imageData, 0, 0);
      }),
    );
  }

  // Annotations stay crisp and keep their selected colors. Geometry is
  // applied afterwards so image and markup still rotate and flip together.
  if (entry.markup.length > 0) pipeline = pipeline.then((data) => applyMarkupToImage(data, entry.markup));

  if (a.freeRotation !== 0) pipeline = pipeline.then((data) => rotateImage(data, a.freeRotation));
  if (a.flipH || a.flipV) pipeline = pipeline.then(imageTools.flip(a.flipH, a.flipV));

  if (a.freeRotation !== 0 && (maxW || maxH)) {
    pipeline = pipeline.then(async (data) => {
      const scale = Math.min((maxW ?? Infinity) / data.width, (maxH ?? Infinity) / data.height, 1);
      if (scale === 1) return data;
      return imageTools.resize(Math.max(1, Math.round(data.width * scale)), Math.max(1, Math.round(data.height * scale)), "fill")(data);
    });
  }

  return pipeline;
};
