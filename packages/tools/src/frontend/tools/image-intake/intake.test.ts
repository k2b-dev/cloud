import { describe, expect, mock, test } from "bun:test";
import { HEIF_MAX_BYTES, HEIF_MAX_PIXELS, IMAGE_ACCEPT } from "./formats";
import { type ImageIntakeDeps, ImageIntakeError, type ImageIntakeFailure, prepareImage } from "./intake";
import { imageIntakeMessages } from "./messages";

const dimensions = { width: 48, height: 32 };
const png = new Blob(["png"], { type: "image/png" });
const file = (name: string, type = "") => new File(["bytes"], name, { type });
const options = () => ({ signal: new AbortController().signal, onStage: mock(() => {}) });
const fail = async (): Promise<never> => {
  throw new Error("cannot decode");
};
const deps = (native = false): ImageIntakeDeps => ({
  decodeNative: mock(async (source) => {
    if (native || source === png) return dimensions;
    return fail();
  }),
  decodeHeif: mock(async () => png),
});
const reason = async (work: Promise<unknown>, expected: ImageIntakeFailure["reason"]) => {
  try {
    await work;
    throw new Error("Expected an intake failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ImageIntakeError);
    if (error instanceof ImageIntakeError) expect(error.reason).toBe(expected);
  }
};

describe("image intake", () => {
  test("rejects all-files picker inputs before decoding", async () => {
    const injected = deps(true);
    await reason(prepareImage(file("x.txt", "text/plain"), options(), injected), "unsupported");
    expect(injected.decodeNative).not.toHaveBeenCalled();
  });
  test("native success preserves the file and never loads HEIF", async () => {
    const injected = deps(true);
    const original = file("photo.HEIC", "image/heic");
    expect(await prepareImage(original, options(), injected)).toEqual({ source: original, ...dimensions });
    expect(injected.decodeHeif).not.toHaveBeenCalled();
  });
  test("fallback verifies its PNG and passes the pixel limit", async () => {
    const injected = deps();
    const settings = options();
    const original = file("photo.heif");
    expect(await prepareImage(original, settings, injected)).toEqual({ source: png, ...dimensions });
    expect(injected.decodeHeif).toHaveBeenCalledWith(original, { ...settings, maxPixels: HEIF_MAX_PIXELS });
    expect(injected.decodeNative).toHaveBeenCalledTimes(2);
  });
  test("sniffs no more than 64 bytes", async () => {
    const original = file("photo.bin", "image/x-unknown");
    const head = new Uint8Array(20);
    new DataView(head.buffer).setUint32(0, 20);
    head.set(new TextEncoder().encode("ftypmif1"), 4);
    head.set(new TextEncoder().encode("heic"), 16);
    const slice = mock((start?: number, end?: number) => {
      expect([start, end]).toEqual([0, 64]);
      return new Blob([head]);
    });
    original.slice = slice;
    expect((await prepareImage(original, options(), deps())).source).toBe(png);
    expect(slice).toHaveBeenCalledTimes(1);
  });
  test("limits HEIF bytes only after native failure", async () => {
    const original = file("large.heic");
    Object.defineProperty(original, "size", { value: HEIF_MAX_BYTES + 1 });
    const injected = deps();
    await reason(prepareImage(original, options(), injected), "too-large");
    expect(injected.decodeHeif).not.toHaveBeenCalled();
    expect((await prepareImage(original, options(), deps(true))).source).toBe(original);
    const ordinary = file("large.png");
    Object.defineProperty(ordinary, "size", { value: HEIF_MAX_BYTES + 1 });
    expect((await prepareImage(ordinary, options(), deps(true))).source).toBe(ordinary);
  });
  test("accepts the byte boundary and allows a test-only pixel budget", async () => {
    const original = file("large.heic");
    Object.defineProperty(original, "size", { value: HEIF_MAX_BYTES });
    const injected = { ...deps(), heifMaxPixels: 1 };
    const settings = options();
    await prepareImage(original, settings, injected);
    expect(injected.decodeHeif).toHaveBeenCalledWith(original, { ...settings, maxPixels: 1 });
  });
  for (const extension of ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif"]) {
    test(`broken .${extension} is damaged rather than unsupported`, async () => {
      await reason(prepareImage(file(`broken.${extension}`), options(), deps()), "decode-failed");
    });
  }
  for (const type of ["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/svg+xml", "image/avif"]) {
    test(`broken ${type}`, async () => {
      await reason(prepareImage(file("photo", type), options(), deps()), "decode-failed");
    });
  }
  test("unknown image types remain unsupported", async () => {
    for (const [name, type] of [
      ["x.tiff", "image/tiff"],
      ["x.dng", "image/x-adobe-dng"],
      ["x", "image/x-unknown"],
    ]) {
      await reason(prepareImage(file(name!, type), options(), deps()), "unsupported");
    }
  });
  test("zero native dimensions count as failure", async () => {
    for (const dimensions of [
      { width: 0, height: 1 },
      { width: 1, height: 0 },
    ]) {
      await reason(prepareImage(file("x.png"), options(), { ...deps(), decodeNative: async () => dimensions }), "decode-failed");
    }
  });
  test("normalizes decoder and verification errors, preserves allocation failures", async () => {
    await reason(prepareImage(file("x.heic"), options(), { ...deps(), decodeHeif: fail }), "decode-failed");
    await reason(prepareImage(file("x.heic"), options(), { ...deps(), decodeNative: fail }), "decode-failed");
    await reason(
      prepareImage(file("x.heic"), options(), {
        ...deps(),
        decodeHeif: async () => {
          throw new ImageIntakeError("too-large");
        },
      }),
      "too-large",
    );
  });
  test("cancels before work and while a native decode is pending", async () => {
    const controller = new AbortController();
    const injected = deps();
    controller.abort();
    await expect(prepareImage(file("x.heic"), { ...options(), signal: controller.signal }, injected)).rejects.toHaveProperty(
      "name",
      "AbortError",
    );
    expect(injected.decodeNative).not.toHaveBeenCalled();
    const running = new AbortController();
    const pending = prepareImage(
      file("x.png"),
      { ...options(), signal: running.signal },
      { ...deps(), decodeNative: () => new Promise(() => {}) },
    );
    running.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
  });
  test("cancels a pending HEIF decode without classifying it as damaged", async () => {
    const controller = new AbortController();
    const pending = prepareImage(
      file("x.heic"),
      { ...options(), signal: controller.signal },
      {
        ...deps(),
        decodeHeif: async () => {
          controller.abort();
          return png;
        },
      },
    );
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
  });
});

describe("accepted input class guard", () => {
  for (const accepted of IMAGE_ACCEPT.split(",")) {
    for (const native of [true, false]) {
      test(`${accepted}: native ${native ? "success" : "failure"} has a ready image or a localized recovery`, async () => {
        const original =
          accepted === "image/*"
            ? file("photo", "image/x-unknown")
            : accepted.startsWith(".")
              ? file(`photo${accepted}`)
              : file("photo", accepted);
        try {
          const image = await prepareImage(original, options(), deps(native));
          expect(image.width).toBeGreaterThan(0);
          expect(image.height).toBeGreaterThan(0);
          expect(image.source).toBeInstanceOf(Blob);
        } catch (error) {
          expect(error).toBeInstanceOf(ImageIntakeError);
          if (!(error instanceof ImageIntakeError)) throw error;
          for (const locale of ["en", "de"]) {
            const message = imageIntakeMessages.resolve([locale]).t;
            expect(message[`${error.reason}Title`].trim().length).toBeGreaterThan(0);
            expect(message[`${error.reason}Hint`].trim().length).toBeGreaterThan(0);
          }
        }
      });
    }
  }
});
