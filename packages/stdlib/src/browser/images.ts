/**
 * Functional image processing API for the browser with chainable transforms.
 *
 * All operations work on an immutable {@link ImgData} container -- each transform
 * creates a new canvas rather than mutating the original. Transforms return
 * functions of type `(ImgData | Promise<ImgData>) => Promise<T>`, so they
 * compose naturally with `Promise.then`.
 *
 * @example
 * // Single image processing
 * const blob = await img
 *   .create(file)
 *   .then(img.resize(800, 600, "cover"))
 *   .then(img.filter(img.filters.vintage))
 *   .then(img.toBlob("webp"));
 *
 * @example
 * // Batch processing with progress
 * const blobs = await img.batch(
 *   files,
 *   (data) => data
 *     .then(img.resize(800, 600, "cover"))
 *     .then(img.filter(img.filters.vintage))
 *     .then(img.toBlob("webp")),
 *   { onProgress: ({ percent }) => console.log(`${Math.round(percent * 100)}%`) }
 * );
 */

// ==========================
// Types
// ==========================

/**
 * Immutable container holding a canvas, its 2D context, and dimensions.
 *
 * Every transform produces a new `ImgData` with a fresh canvas; the
 * original is never modified.
 */
export type ImgData = Readonly<{
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
}>;

type Fit = "cover" | "contain" | "fill";
type Format = "jpeg" | "webp" | "png";
type Source = File | Blob | HTMLImageElement | HTMLCanvasElement | string;
type Transform<T = ImgData> = (data: ImgData | Promise<ImgData>) => Promise<T>;
type Progress = { current: number; total: number; percent: number };

// ==========================
// Internal Helpers
// ==========================

/** Validate that w/h are positive finite integers. Throws a clear error
 *  rather than letting a bad value propagate to a 0×0 canvas, NaN/Infinity
 *  in DOM exceptions, or browser-specific failures. */
const assertDims = (w: number, h: number, fn: string): void => {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new RangeError(
      `images.${fn}: width and height must be positive finite numbers (got ${w}×${h})`,
    );
  }
};

/** Create canvas with specified dimensions. */
const mkCanvas = (w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  assertDims(w, h, "mkCanvas");
  const c = Object.assign(document.createElement("canvas"), {
    width: w,
    height: h,
  });
  const ctx = c.getContext("2d");
  if (!ctx) {
    // getContext returns null when too many live canvas contexts exist
    // (Chrome ~300 cap), or when the page lost hardware acceleration.
    throw new Error(
      "images: could not acquire 2D context (too many canvases or accelerated context lost)",
    );
  }
  return [c, ctx];
};

/** Create ImgData by drawing on a new canvas with given dimensions. */
const draw = (w: number, h: number, fn: (ctx: CanvasRenderingContext2D) => void): ImgData => {
  const [canvas, ctx] = mkCanvas(w, h);
  fn(ctx);
  return { canvas, ctx, width: w, height: h };
};

/** Resolve image data from either direct value or promise. */
const resolve = async (data: ImgData | Promise<ImgData>): Promise<ImgData> => data;

// ==========================
// Factory
// ==========================

/**
 * Loads an image from various sources and produces an {@link ImgData}.
 *
 * Accepted sources: `File`, `Blob`, `HTMLImageElement`, `HTMLCanvasElement`,
 * or a URL string. For `Blob`/`File` inputs an object URL is created and
 * automatically revoked after loading. For URL strings, `crossOrigin` is set
 * to `"anonymous"` so the resulting canvas is not tainted.
 *
 * @throws {Error} If the image fails to load (e.g. invalid URL or corrupt data).
 *
 * @example
 * const data = await images.create(file);
 * const data2 = await images.create("https://example.com/photo.jpg");
 */
const create = async (source: Source): Promise<ImgData> => {
  // Canvas can be directly copied
  if (source instanceof HTMLCanvasElement) return draw(source.width, source.height, (ctx) => ctx.drawImage(source, 0, 0));

  // Existing HTMLImageElement: if it's still loading, await load before
  // drawing — otherwise the canvas would be blank.
  if (source instanceof HTMLImageElement) {
    if (!source.complete || source.naturalWidth === 0) {
      await new Promise<void>((res, rej) => {
        source.addEventListener("load", () => res(), { once: true });
        source.addEventListener(
          "error",
          () => rej(new Error("Failed to load HTMLImageElement")),
          { once: true },
        );
      });
    }
    return draw(source.naturalWidth || source.width, source.naturalHeight || source.height, (ctx) =>
      ctx.drawImage(source, 0, 0),
    );
  }

  // Load from File/Blob/URL. Attach handlers BEFORE setting src so we never
  // miss the load event for cached or data: URLs (which can fire synchronously).
  const i = Object.assign(new Image(), { crossOrigin: "anonymous" });
  const url = source instanceof Blob ? URL.createObjectURL(source) : source;
  const loadPromise = new Promise<void>((res, rej) => {
    i.onload = () => res();
    i.onerror = () => rej(new Error("Failed to load image"));
  });
  i.src = url;
  try {
    await loadPromise;
  } finally {
    if (source instanceof Blob) URL.revokeObjectURL(url);
  }

  return draw(i.naturalWidth || i.width, i.naturalHeight || i.height, (ctx) =>
    ctx.drawImage(i, 0, 0),
  );
};

// ==========================
// Batch
// ==========================

/**
 * Processes multiple images through the same transform pipeline sequentially.
 *
 * The optional `onProgress` callback fires twice per image (before and after
 * processing), providing `current`, `total`, and `percent` (0 to 1).
 *
 * Images are processed one at a time to avoid excessive memory pressure from
 * concurrent canvas allocations.
 *
 * @example
 * const blobs = await images.batch(
 *   fileList,
 *   (data) => data.then(images.resize(300, 300, "cover")).then(images.toBlob("webp")),
 *   { onProgress: ({ percent }) => console.log(percent) }
 * );
 */
const batch = async <T>(
  sources: Source[],
  transform: (data: Promise<ImgData>) => Promise<T>,
  opts: { onProgress?: (progress: Progress) => void } = {},
): Promise<T[]> => {
  const results: T[] = [];
  const total = sources.length;

  for (let i = 0; i < total; i++) {
    // Report progress before processing (show which image is being processed)
    opts.onProgress?.({ current: i, total, percent: (i + 0.5) / total });
    results.push(await transform(create(sources[i]!)));
    // Report progress after processing
    opts.onProgress?.({ current: i + 1, total, percent: (i + 1) / total });
  }

  return results;
};

// ==========================
// Transforms
// ==========================

/**
 * Resizes an image to the given dimensions.
 *
 * Fit modes:
 * - `"fill"` (default) -- stretches to exact dimensions, ignoring aspect ratio.
 * - `"cover"` -- scales and center-crops so the image fills the entire area
 *   with no letterboxing; parts of the image may be clipped.
 * - `"contain"` -- scales to fit within the dimensions, preserving aspect
 *   ratio. Empty space is filled with `letterboxColor`.
 *
 * If only one dimension is provided, the other is calculated from the
 * source aspect ratio.
 */
const resize =
  (width?: number, height?: number, fit: Fit = "fill", letterboxColor: string = "#000"): Transform =>
  async (data) => {
    const d = await resolve(data);
    if (!width && !height) return d;
    // Reject invalid inputs early. Was: width: 0 silently produced a 0×0 canvas.
    if (width !== undefined && (!Number.isFinite(width) || width <= 0)) {
      throw new RangeError(`images.resize: invalid width ${width}`);
    }
    if (height !== undefined && (!Number.isFinite(height) || height <= 0)) {
      throw new RangeError(`images.resize: invalid height ${height}`);
    }

    // Calculate target dimensions maintaining aspect ratio if one dimension missing
    const ar = d.width / d.height;
    const [tw, th] = [width ?? height! * ar, height ?? width! / ar];

    // Fill mode: stretch to exact dimensions
    if (fit === "fill") return draw(tw, th, (ctx) => ctx.drawImage(d.canvas, 0, 0, tw, th));

    // Cover mode: crop to fill entire area
    if (fit === "cover") {
      const scale = Math.max(tw / d.width, th / d.height);
      const [sw, sh] = [tw / scale, th / scale];
      const [sx, sy] = [(d.width - sw) / 2, (d.height - sh) / 2];
      return draw(tw, th, (ctx) => ctx.drawImage(d.canvas, sx, sy, sw, sh, 0, 0, tw, th));
    }

    // Contain mode: fit with letterbox/pillarbox
    const scale = Math.min(tw / d.width, th / d.height);
    const [dw, dh] = [d.width * scale, d.height * scale];
    const [dx, dy] = [(tw - dw) / 2, (th - dh) / 2];
    return draw(tw, th, (ctx) => {
      ctx.fillStyle = letterboxColor;
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(d.canvas, dx, dy, dw, dh);
    });
  };

/**
 * Crops the image to a rectangle defined by pixel coordinates.
 *
 * Coordinates are relative to the top-left corner of the source image.
 * No bounds checking is performed -- out-of-range values produce transparent pixels.
 */
const crop =
  (x: number, y: number, w: number, h: number): Transform =>
  async (data) => {
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      throw new RangeError(
        `images.crop: w/h must be positive finite numbers (got ${w}×${h})`,
      );
    }
    const d = await resolve(data);
    return draw(w, h, (ctx) => ctx.drawImage(d.canvas, x, y, w, h, 0, 0, w, h));
  };

/**
 * Applies a CSS filter string to the image.
 *
 * The filter string uses the same syntax as the CSS `filter` property
 * (e.g. `"blur(5px) contrast(1.2)"`). Use {@link filters} for presets.
 *
 * @example
 * images.filter("grayscale(1) brightness(1.1)")
 * images.filter(images.filters.vintage)
 */
const filter =
  (filterStr: string): Transform =>
  async (data) => {
    const d = await resolve(data);
    return draw(d.width, d.height, (ctx) => {
      ctx.filter = filterStr;
      ctx.drawImage(d.canvas, 0, 0);
    });
  };

/**
 * Rotates the image by a fixed angle.
 *
 * Only 90, 180, and 270 degree rotations are supported. For 90 and 270
 * the output dimensions are swapped (width becomes height and vice versa).
 */
const rotate =
  (deg: 90 | 180 | 270): Transform =>
  async (data) => {
    const d = await resolve(data);
    const swap = deg % 180 !== 0;
    const [w, h] = swap ? [d.height, d.width] : [d.width, d.height];
    return draw(w, h, (ctx) => {
      ctx.translate(w / 2, h / 2);
      ctx.rotate((deg * Math.PI) / 180);
      ctx.drawImage(d.canvas, -d.width / 2, -d.height / 2);
    });
  };

/**
 * Flips the image along one or both axes.
 *
 * By default flips horizontally (mirror). Pass `(false, true)` for a
 * vertical flip, or `(true, true)` for both.
 */
const flip =
  (horizontal = true, vertical = false): Transform =>
  async (data) => {
    const d = await resolve(data);
    return draw(d.width, d.height, (ctx) => {
      ctx.scale(horizontal ? -1 : 1, vertical ? -1 : 1);
      ctx.drawImage(d.canvas, horizontal ? -d.width : 0, vertical ? -d.height : 0);
    });
  };

/**
 * Applies a custom drawing function to a copy of the image canvas.
 *
 * The callback receives the 2D context and canvas of a fresh copy. Use this
 * for operations not covered by the built-in transforms (e.g. drawing
 * watermarks, overlays, or custom pixel manipulation).
 *
 * @example
 * images.apply((ctx, canvas) => {
 *   ctx.font = "24px sans-serif";
 *   ctx.fillText("Watermark", 10, canvas.height - 30);
 * })
 */
const apply =
  (fn: (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => void): Transform =>
  async (data) => {
    const d = await resolve(data);
    const out = draw(d.width, d.height, (ctx) => ctx.drawImage(d.canvas, 0, 0));
    fn(out.ctx, out.canvas);
    return { ...out, width: out.canvas.width, height: out.canvas.height };
  };

// ==========================
// Output
// ==========================

/**
 * Converts the image to a `Blob` with the given format and quality.
 *
 * Quality (0 to 1) is ignored for `"png"` format. Defaults to `"webp"` at 0.9.
 *
 * @throws {Error} If blob creation fails (e.g. canvas is tainted by cross-origin data).
 */
const toBlob =
  (format: Format = "webp", quality = 0.9): Transform<Blob> =>
  async (data) => {
    const d = await resolve(data);
    return new Promise((res, rej) => d.canvas.toBlob((b) => (b ? res(b) : rej(new Error("Blob failed"))), `image/${format}`, quality));
  };

/**
 * Converts the image to a base64-encoded data URL string (e.g. `"data:image/webp;base64,..."`).
 *
 * Useful for embedding images directly in HTML or CSS. Defaults to `"webp"` at 0.9 quality.
 */
const toBase64 =
  (format: Format = "webp", quality = 0.9): Transform<string> =>
  async (data) =>
    (await resolve(data)).canvas.toDataURL(`image/${format}`, quality);

/**
 * Converts the image to a `File` object with the given filename.
 *
 * The file's MIME type is set based on the format. Useful for uploading
 * processed images via `FormData`.
 */
const toFile =
  (name: string, format: Format = "webp", quality = 0.9): Transform<File> =>
  async (data) =>
    new File([await toBlob(format, quality)(data)], name, {
      type: `image/${format}`,
    });

/**
 * Extracts the raw `HTMLCanvasElement` from the image data.
 *
 * Useful when you need direct canvas access for custom rendering or
 * appending to the DOM.
 */
const toCanvas = async (data: ImgData | Promise<ImgData>): Promise<HTMLCanvasElement> => (await resolve(data)).canvas;

// ==========================
// Filters & Presets
// ==========================

/**
 * Predefined CSS filter strings and generator functions.
 *
 * Static presets (`vintage`, `grayscale`, `dramatic`, `soft`) are ready-to-use
 * filter strings. Generator functions (`blur`, `brightness`, `contrast`,
 * `saturate`, `hue`) accept a numeric value and return a filter string.
 *
 * @example
 * images.filter(images.filters.vintage)
 * images.filter(images.filters.blur(5))
 */
const filters = {
  vintage: "sepia(0.3) contrast(1.1) brightness(1.1) saturate(1.3)",
  grayscale: "grayscale(1) contrast(1.1)",
  dramatic: "contrast(1.4) brightness(0.9) saturate(1.2)",
  soft: "brightness(1.05) saturate(0.9) blur(0.5px)",
  blur: (px: number) => `blur(${px}px)`,
  brightness: (v: number) => `brightness(${v})`,
  contrast: (v: number) => `contrast(${v})`,
  saturate: (v: number) => `saturate(${v})`,
  hue: (deg: number) => `hue-rotate(${deg}deg)`,
} as const;

/**
 * Ready-to-use image processing presets combining multiple transforms.
 *
 * Each preset accepts a source and optional parameters, returning a promise
 * that resolves to the processed result.
 */
const presets = {
  /**
   * Creates a square avatar from any source.
   *
   * Center-crops to the given size using `"cover"` mode, applies a subtle
   * contrast/saturation boost, and returns a base64 data URL.
   */
  avatar: (src: Source, size = 512, quality = 0.8, fmt: Format = "webp"): Promise<string> =>
    create(src)
      .then(resize(size, size, "cover"))
      .then(filter("contrast(1.05) saturate(1.1)"))
      .then(toBase64(fmt, quality)),

  /**
   * Creates an optimized thumbnail with letterboxing.
   *
   * Fits the image within a square of `maxSize` using `"contain"` mode,
   * filling empty space with `letterboxColor`, and returns a base64 data URL.
   */
  thumbnail: (src: Source, maxSize = 300, letterboxColor = "#000", fmt: Format = "webp"): Promise<string> =>
    create(src)
      .then(resize(maxSize, maxSize, "contain", letterboxColor))
      .then(toBase64(fmt, 0.8)),
} as const;

// ==========================
// Export
// ==========================

/**
 * Image processing namespace with chainable transforms, output converters,
 * filter presets, and batch processing.
 */
export const images = {
  create,
  batch,
  resize,
  crop,
  filter,
  rotate,
  flip,
  apply,
  toBlob,
  toBase64,
  toFile,
  toCanvas,
  filters,
  presets,
} as const;

export const img = images;
