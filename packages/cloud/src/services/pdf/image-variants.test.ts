import { expect, spyOn, test } from "bun:test";
import sharp, * as sharpModule from "sharp";
import { prepareImageVariants } from "./image-variants";

test("three boxes inspect metadata and decode the source once at the largest needed size", async () => {
  const source = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const resize = spyOn(Object.getPrototypeOf(sharp()), "resize");
  const factory = spyOn(sharpModule, "default");
  const written: { index: number; width: number; height: number }[] = [];
  try {
    const result = await prepareImageVariants(
      source,
      { boxes: [800, 1600, 400].map((width) => ({ width, height: 2000 })), maxBytes: 1_000_000, timeoutMs: 30_000 },
      async (index, _header, bytes) => {
        const metadata = await sharp(bytes).metadata();
        written.push({ index, width: metadata.width, height: metadata.height });
      },
    );
    expect(result.ok).toBe(true);
    expect(factory.mock.calls.filter(([input]) => input === source)).toHaveLength(2);
    expect(resize.mock.calls[0]).toEqual([{ width: 1600, height: 2000, fit: "inside", withoutEnlargement: true }]);
    expect(written).toEqual([
      { index: 0, width: 800, height: 600 },
      { index: 1, width: 1600, height: 1200 },
      { index: 2, width: 400, height: 300 },
    ]);
  } finally {
    resize.mockRestore();
    factory.mockRestore();
  }
}, 30_000);

test("an all-pass-through call validates the JPEG once before writing unchanged bytes", async () => {
  const source = await sharp({ create: { width: 32, height: 16, channels: 3, background: "red" } })
    .jpeg()
    .toBuffer();
  const factory = spyOn(sharpModule, "default");
  const written: Uint8Array[] = [];
  try {
    const result = await prepareImageVariants(
      source,
      {
        boxes: [
          { width: 64, height: 64 },
          { width: 32, height: 16 },
        ],
        maxBytes: 1_000_000,
        timeoutMs: 30_000,
      },
      async (_, _header, bytes) => {
        written.push(bytes);
      },
    );
    expect(result.ok).toBe(true);
    expect(factory.mock.calls.filter(([input]) => input === source)).toHaveLength(2);
    expect(written).toEqual([source, source]);
  } finally {
    factory.mockRestore();
  }
}, 30_000);

test("re-encodes a fitting JPEG with an embedded colour profile to sRGB", async () => {
  const source = await sharp({ create: { width: 32, height: 16, channels: 3, background: "red" } })
    .withIccProfile("p3")
    .jpeg()
    .toBuffer();
  expect((await sharp(source).metadata()).hasProfile).toBe(true);
  const written: Uint8Array[] = [];
  const result = await prepareImageVariants(
    source,
    { boxes: [{ width: 64, height: 64 }], maxBytes: 1_000_000, timeoutMs: 30_000 },
    async (_, _header, bytes) => {
      written.push(bytes);
    },
  );
  expect(result.ok).toBe(true);
  expect(written).toHaveLength(1);
  expect(Buffer.from(written[0]!).equals(source)).toBe(false);
  expect((await sharp(written[0]!).metadata()).hasProfile).toBe(false);
}, 30_000);

test("rejects an intermediate over 16 MiP before decoding", async () => {
  // A highly compressible image has modest encoded size but an oversized raw intermediate.
  const source = await sharp({ create: { width: 4096, height: 4097, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const factory = spyOn(sharpModule, "default");
  try {
    expect(
      await prepareImageVariants(source, { boxes: [{ width: 8192, height: 8192 }], maxBytes: 1_000_000, timeoutMs: 30_000 }, async () => {
        throw new Error("Must not encode");
      }),
    ).toEqual({ ok: false, code: "too_large" });
    expect(factory.mock.calls.filter(([input]) => input === source)).toHaveLength(1);
  } finally {
    factory.mockRestore();
  }
}, 30_000);

test("fitting a rounded aspect ratio never shrinks then enlarges the decode", async () => {
  const source = await sharp({ create: { width: 5, height: 3, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const factory = spyOn(sharpModule, "default");
  const decodedSizes: [number, number][] = [];
  try {
    const result = await prepareImageVariants(
      source,
      {
        boxes: [
          { width: 4, height: 3 },
          { width: 3, height: 3 },
        ],
        maxBytes: 1000,
        timeoutMs: 30_000,
      },
      async (_, _header, bytes) => {
        const metadata = await sharp(bytes).metadata();
        decodedSizes.push([metadata.width, metadata.height]);
      },
    );
    expect(result.ok).toBe(true);
    expect(decodedSizes).toEqual([
      [4, 2],
      [3, 2],
    ]);
    const rawPipeline = factory.mock.calls.find(([, options]) => options?.raw);
    expect(rawPipeline?.[1]?.raw).toMatchObject({ width: 4, height: 2 });
  } finally {
    factory.mockRestore();
  }
}, 30_000);

test("a grey+alpha PNG with a transparent pixel stays PNG with alpha", async () => {
  const source = await sharp(Buffer.from([64, 0, 192, 255]), { raw: { width: 2, height: 1, channels: 2 } })
    .toColourspace("b-w")
    .png()
    .toBuffer();
  expect((await sharp(source).metadata()).channels).toBe(2);
  let writes = 0;
  const result = await prepareImageVariants(
    source,
    { boxes: [{ width: 2, height: 1 }], maxBytes: 1000, timeoutMs: 30_000 },
    async (index, header, bytes) => {
      writes++;
      expect(index).toBe(0);
      expect(header).toEqual({ type: "image/png", width: 2, height: 1, bytes: bytes.byteLength });
      expect((await sharp(bytes).metadata()).hasAlpha).toBe(true);
      const decoded = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
      expect(decoded.data[decoded.info.channels - 1]).toBe(0);
    },
  );
  expect(result).toEqual({ ok: true });
  expect(writes).toBe(1);
});

test("validates before pass-through writes and awaits each write before encoding the next variant", async () => {
  const source = await sharp({ create: { width: 32, height: 16, channels: 3, background: "red" } })
    .jpeg()
    .toBuffer();
  const factory = spyOn(sharpModule, "default");
  const order: number[] = [];
  try {
    const result = await prepareImageVariants(
      source,
      {
        boxes: [
          { width: 16, height: 16 },
          { width: 32, height: 16 },
          { width: 8, height: 8 },
        ],
        maxBytes: 1000,
        timeoutMs: 30_000,
      },
      async (index, header, bytes) => {
        order.push(index);
        expect(header.bytes).toBe(bytes.byteLength);
        if (index === 1) expect(bytes).toBe(source);
        const calls = factory.mock.calls.length;
        expect(calls).toBe(index === 1 ? 2 : index === 0 ? 4 : 5);
        await Bun.sleep(1);
        expect(factory.mock.calls).toHaveLength(calls);
      },
    );
    expect(result).toEqual({ ok: true });
    expect(order).toEqual([1, 0, 2]);
    expect(factory.mock.calls.filter(([input]) => input === source)).toHaveLength(3);
  } finally {
    factory.mockRestore();
  }
});

test.each(["out of memory", "insufficient memory", "memory allocation failed", "cannot allocate", "pixel limit exceeded"])(
  "classifies %s before corrupt-header or unsupported-format messages",
  async (message) => {
    const metadata = spyOn(Object.getPrototypeOf(sharp()), "metadata").mockRejectedValueOnce(
      new Error(`Input buffer has corrupt header: ${message}; unsupported image format`),
    );
    let writes = 0;
    try {
      expect(
        await prepareImageVariants(
          new Uint8Array([1]),
          {
            boxes: [{ width: 8, height: 8 }],
            maxBytes: 1000,
            timeoutMs: 30_000,
          },
          async () => {
            writes++;
          },
        ),
      ).toEqual({ ok: false, code: "too_large" });
      expect(writes).toBe(0);
    } finally {
      metadata.mockRestore();
    }
  },
);

test("a corrupt JPEG writes no pass-through records, even with several fitting boxes", async () => {
  const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "red" } })
    .jpeg()
    .toBuffer();
  const source = jpeg.subarray(0, Math.floor(jpeg.byteLength / 3));
  let writes = 0;
  expect(
    await prepareImageVariants(
      source,
      {
        boxes: [
          { width: 2008, height: 2900 },
          { width: 800, height: 600 },
          { width: 8, height: 8 },
        ],
        maxBytes: 1_000_000,
        timeoutMs: 30_000,
      },
      async () => {
        writes++;
      },
    ),
  ).toEqual({ ok: false, code: "unreadable" });
  expect(writes).toBe(0);
});
