import type { ReaderOptions, ReadResult } from "zxing-wasm/reader";

type ScannerPoint = { x: number; y: number };

export type ScannerDetection = {
  rawValue: string;
  format: string;
  cornerPoints: ScannerPoint[];
  boundingBox: { x: number; y: number; width: number; height: number } | null;
};

export type ScannerEngine = {
  decodeVideoFrame(video: HTMLVideoElement): Promise<ScannerDetection[]>;
};

let readerPromise: Promise<typeof import("zxing-wasm/reader")> | null = null;

type NativeBarcodeDetection = {
  rawValue: string;
  format: string;
  boundingBox?: DOMRectReadOnly;
  cornerPoints?: ScannerPoint[];
};

type NativeBarcodeDetector = {
  detect(source: HTMLVideoElement): Promise<NativeBarcodeDetection[]>;
};

type NativeBarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): NativeBarcodeDetector;
  getSupportedFormats?: () => Promise<string[]>;
};

const nativeFormats = ["qr_code", "code_128", "code_39", "data_matrix", "ean_13", "ean_8", "itf", "pdf417"];
let nativeDetectorPromise: Promise<NativeBarcodeDetector | null> | null = null;

const loadNativeDetector = async (): Promise<NativeBarcodeDetector | null> => {
  nativeDetectorPromise ??= (async () => {
    const ctor = (globalThis as { BarcodeDetector?: NativeBarcodeDetectorConstructor }).BarcodeDetector;
    if (!ctor) return null;
    try {
      const supported = ctor.getSupportedFormats ? await ctor.getSupportedFormats() : nativeFormats;
      const formats = nativeFormats.filter((format) => supported.includes(format));
      if (formats.length === 0) return null;
      return new ctor({ formats });
    } catch {
      return null;
    }
  })();
  return nativeDetectorPromise;
};

const loadReader = async () => {
  readerPromise ??= Promise.all([import("zxing-wasm/reader"), import("zxing-wasm/reader/zxing_reader.wasm")]).then(([reader, wasm]) => {
    reader.prepareZXingModule({
      overrides: {
        locateFile: () => wasm.default,
      },
    });
    return reader;
  });
  return readerPromise;
};

const options: ReaderOptions = {
  formats: ["QRCode", "Code128", "Code39", "DataMatrix", "EAN13", "EAN8", "ITF", "PDF417"],
  maxNumberOfSymbols: 4,
  textMode: "Plain",
  tryHarder: true,
  tryInvert: true,
  tryRotate: true,
};

const normalizedPoints = (result: ReadResult, width: number, height: number): ScannerPoint[] => {
  const position = result.position;
  const points = [position.topLeft, position.topRight, position.bottomRight, position.bottomLeft];
  return points.map((point) => ({
    x: Math.max(0, Math.min(1, point.x / width)),
    y: Math.max(0, Math.min(1, point.y / height)),
  }));
};

const boundingBox = (points: ScannerPoint[]): ScannerDetection["boundingBox"] => {
  if (points.length === 0) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
};

const normalizeNativePoints = (points: ScannerPoint[] | undefined, width: number, height: number): ScannerPoint[] =>
  (points ?? []).map((point) => ({
    x: Math.max(0, Math.min(1, point.x / width)),
    y: Math.max(0, Math.min(1, point.y / height)),
  }));

const normalizeNativeBox = (
  box: DOMRectReadOnly | undefined,
  points: ScannerPoint[],
  width: number,
  height: number,
): ScannerDetection["boundingBox"] => {
  if (box) {
    return {
      x: Math.max(0, Math.min(1, box.x / width)),
      y: Math.max(0, Math.min(1, box.y / height)),
      width: Math.max(0, Math.min(1, box.width / width)),
      height: Math.max(0, Math.min(1, box.height / height)),
    };
  }
  return boundingBox(points);
};

const decodeNative = async (video: HTMLVideoElement, sourceWidth: number, sourceHeight: number): Promise<ScannerDetection[] | null> => {
  const detector = await loadNativeDetector();
  if (!detector) return null;
  try {
    const results = await detector.detect(video);
    return results
      .filter((result) => result.rawValue.trim())
      .map((result) => {
        const cornerPoints = normalizeNativePoints(result.cornerPoints, sourceWidth, sourceHeight);
        return {
          rawValue: result.rawValue.trim(),
          format: result.format,
          cornerPoints,
          boundingBox: normalizeNativeBox(result.boundingBox, cornerPoints, sourceWidth, sourceHeight),
        };
      });
  } catch {
    return null;
  }
};

export const createScannerEngine = (canvasError = "Scanner canvas could not be created."): ScannerEngine => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error(canvasError);

  return {
    async decodeVideoFrame(video) {
      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      if (sourceWidth <= 0 || sourceHeight <= 0) return [];
      const native = await decodeNative(video, sourceWidth, sourceHeight);
      if (native) return native;
      const maxSide = 960;
      const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      canvas.width = width;
      canvas.height = height;
      ctx.drawImage(video, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      const reader = await loadReader();
      const results = await reader.readBarcodes(imageData, options);
      return results
        .filter((result) => result.isValid && result.text.trim())
        .map((result) => {
          const cornerPoints = normalizedPoints(result, width, height);
          return {
            rawValue: result.text.trim(),
            format: result.format,
            cornerPoints,
            boundingBox: boundingBox(cornerPoints),
          };
        });
    },
  };
};
