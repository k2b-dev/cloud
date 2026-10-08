import { describe, expect, test } from "bun:test";
import { ImageMetadataError, stripImageDataUrlMetadata, stripImageMetadata } from "@k2b/cloud/services/image-metadata";
import {
  cameraExif,
  imageBytes,
  imageText,
  jpegSegment,
  pngChunk,
  riffChunk,
  tinyJpeg,
  tinyPng,
  webpRiff,
  withCameraMetadata,
} from "../../../../scripts/fixtures/image-metadata";

const contains = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(Buffer.from(text));

// Read the synthesized TIFF independently of the helper, including its entire IFD0.
const orientationOf = (bytes: Uint8Array): number => {
  const start = Buffer.from(bytes).indexOf(Buffer.from("Exif\0\0"));
  expect(start).toBeGreaterThan(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset + start + 6);
  expect(view.getUint16(0)).toBe(0x4d4d);
  const ifd = view.getUint32(4);
  expect(view.getUint16(ifd)).toBe(1);
  expect(view.getUint16(ifd + 2)).toBe(0x0112);
  expect(view.getUint32(ifd + 14)).toBe(0);
  return view.getUint16(ifd + 10);
};

const rejects = (bytes: Uint8Array) => {
  expect(() => stripImageMetadata(bytes)).toThrow(ImageMetadataError);
  try {
    stripImageMetadata(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(ImageMetadataError);
    if (!(error instanceof ImageMetadataError)) throw error;
    expect(error.status).toBe(422);
  }
};

describe("lossless image metadata privacy", () => {
  test("JPEG preserves orientation, ICC chunks and every codec byte; removes device, GPS, XMP, comments, foreign APPn and trailing bytes", async () => {
    const jpeg = await tinyJpeg();
    const icc = imageBytes(
      jpegSegment(0xe2, imageBytes(imageText("ICC_PROFILE\0"), new Uint8Array([1, 2, 11]))),
      jpegSegment(0xe2, imageBytes(imageText("ICC_PROFILE\0"), new Uint8Array([2, 2, 12]))),
    );
    const input = withCameraMetadata(imageBytes(jpeg.subarray(0, 2), icc, jpeg.subarray(2)));
    const out = stripImageMetadata(input);
    expect(orientationOf(out)).toBe(6);
    for (const text of ["Apple", "GPS", "xap", "IPTC", "comment", "APP11", "polyglot"]) expect(contains(out, text)).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from(icc))).toBe(true);
    expect(out.subarray(out.length - 2)).toEqual(new Uint8Array([255, 217]));
    expect(await new Bun.Image(out).metadata()).toMatchObject({ width: 2, height: 3 });
    // Removing the sole synthesized APP1 and the added ICC leaves the original JPEG exactly.
    const exif = Buffer.from(out).indexOf(Buffer.from("Exif\0\0")) - 4;
    const withoutExif = imageBytes(out.subarray(0, exif), out.subarray(exif + 36));
    const iccOffset = Buffer.from(withoutExif).indexOf(Buffer.from(icc));
    expect(imageBytes(withoutExif.subarray(0, iccOffset), withoutExif.subarray(iccOffset + icc.length))).toEqual(jpeg);
    expect(stripImageMetadata(out)).toEqual(out);
  });

  test("progressive JPEG scans survive, including metadata between scans", async () => {
    const jpeg = await tinyJpeg(true);
    const marker = Buffer.from(jpeg).indexOf(Buffer.from([255, 196]), Buffer.from(jpeg).indexOf(Buffer.from([255, 218])) + 2);
    expect(marker).toBeGreaterThan(0);
    const input = imageBytes(jpeg.subarray(0, marker), jpegSegment(0xfe, imageText("GPS between scans")), jpeg.subarray(marker));
    const out = stripImageMetadata(input);
    expect(out).toEqual(jpeg);
    expect(await new Bun.Image(out).png().bytes()).toEqual(await new Bun.Image(jpeg).png().bytes());
  });

  test("entropy byte stuffing, restart markers and DNL remain byte-exact", () => {
    const jpeg = imageBytes(
      new Uint8Array([255, 216]),
      jpegSegment(0xc0, new Uint8Array([8, 0, 2, 0, 3, 1, 1, 0x11, 0])),
      jpegSegment(0xda, new Uint8Array([1, 1, 0, 0, 63, 0])),
      new Uint8Array([0x22, 255, 0, 0x33, 255, 0xd0, 0x44, 255, 255, 0xd1, 0x55]),
      jpegSegment(0xdc, new Uint8Array([0, 2])),
      new Uint8Array([0x12, 255, 0, 0x13, 255, 217]),
    );
    expect(stripImageMetadata(withCameraMetadata(jpeg, 1))).toEqual(jpeg);
  });

  test("little-endian EXIF and all eight orientations; orientation 1 needs no EXIF", async () => {
    const jpeg = await tinyJpeg();
    for (let orientation = 1; orientation <= 8; orientation++) {
      const out = stripImageMetadata(withCameraMetadata(jpeg, orientation, true));
      if (orientation === 1) expect(out).toEqual(jpeg);
      else expect(orientationOf(out)).toBe(orientation);
    }
  });

  test("JFIF thumbnails are removed", async () => {
    const jpeg = await tinyJpeg();
    const header = imageBytes(imageText("JFIF\0"), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 1, 1]));
    const out = stripImageMetadata(
      imageBytes(jpeg.subarray(0, 2), jpegSegment(0xe0, imageBytes(header, new Uint8Array([13, 14, 15]))), jpeg.subarray(2)),
    );
    expect(Buffer.from(out).includes(Buffer.from([13, 14, 15]))).toBe(false);
    expect(await new Bun.Image(out).metadata()).toMatchObject({ width: 3, height: 2 });
  });

  test("malformed TIFF headers, IFD0 tables and orientation types fail with a typed 422", async () => {
    const jpeg = await tinyJpeg();
    const corruptions = [
      (exif: Uint8Array) => {
        exif[6] = 0;
      },
      (exif: Uint8Array) => {
        exif[9] = 41;
      },
      (exif: Uint8Array) => {
        exif[10] = 255;
      },
      (exif: Uint8Array) => {
        exif[14] = 255;
      },
      (exif: Uint8Array) => {
        exif[19] = 4;
      },
    ];
    for (const corrupt of corruptions) {
      const exif = cameraExif();
      corrupt(exif);
      rejects(imageBytes(jpeg.subarray(0, 2), jpegSegment(0xe1, exif), jpeg.subarray(2)));
    }
    for (const length of [13, 16, 49]) {
      rejects(imageBytes(jpeg.subarray(0, 2), jpegSegment(0xe1, cameraExif().subarray(0, length)), jpeg.subarray(2)));
    }
    const duplicate = cameraExif();
    duplicate.set(duplicate.subarray(16, 28), 28);
    rejects(imageBytes(jpeg.subarray(0, 2), jpegSegment(0xe1, duplicate), jpeg.subarray(2)));
    rejects(imageBytes(jpeg.subarray(0, 2), jpegSegment(0xe1, cameraExif(6)), jpegSegment(0xe1, cameraExif(3)), jpeg.subarray(2)));
  });

  test("every truncated JPEG fails without leaking a RangeError", async () => {
    const jpeg = withCameraMetadata(await tinyJpeg());
    const eoi = Buffer.from(jpeg).lastIndexOf(Buffer.from([255, 217]));
    for (let end = 2; end < eoi + 2; end++) rejects(jpeg.subarray(0, end));
    rejects(new Uint8Array([255, 216, 255, 217]));
  });

  test("PNG allow-list preserves colour, transparency, APNG and compressed pixels, dropping all text/EXIF and the tail", async () => {
    const png = tinyPng();
    const control = new Uint8Array(8);
    new DataView(control.buffer).setUint32(0, 2);
    const frame = new Uint8Array(26);
    const frameView = new DataView(frame.buffer);
    frameView.setUint32(4, 3);
    frameView.setUint32(8, 2);
    frameView.setUint16(20, 1);
    frameView.setUint16(22, 100);
    const kept = imageBytes(
      pngChunk("iCCP", imageBytes(imageText("profile\0\0"), new Uint8Array([120, 156, 3, 0, 0, 0, 0, 1]))),
      pngChunk("tRNS", new Uint8Array(6)),
      pngChunk("acTL", control),
      pngChunk("fcTL", frame),
      pngChunk("pHYs", new Uint8Array(9)),
    );
    const secondFrame = frame.slice();
    new DataView(secondFrame.buffer).setUint32(0, 1);
    const idatSize = new DataView(png.buffer).getUint32(33);
    const frameData = imageBytes(new Uint8Array([0, 0, 0, 2]), png.subarray(41, 41 + idatSize));
    const frames = imageBytes(pngChunk("fcTL", secondFrame), pngChunk("fdAT", frameData));
    const removed = imageBytes(...["eXIf", "tEXt", "iTXt", "zTXt", "tIME", "zzZZ"].map((type) => pngChunk(type, imageText("GPS device"))));
    const out = stripImageMetadata(
      imageBytes(png.subarray(0, 33), removed, kept, png.subarray(33, png.length - 12), frames, png.subarray(-12), imageText("polyglot")),
    );
    expect(out).toEqual(imageBytes(png.subarray(0, 33), kept, png.subarray(33, png.length - 12), frames, png.subarray(-12)));
    expect(contains(out, "GPS")).toBe(false);
    const decodable = stripImageMetadata(imageBytes(png.subarray(0, 33), removed, png.subarray(33)));
    expect(await new Bun.Image(decodable).metadata()).toMatchObject({ width: 3, height: 2 });
  });

  test("PNG rejects broken lengths, absent/duplicate headers, missing data and truncated containers", () => {
    const png = tinyPng();
    const broken = png.slice();
    new DataView(broken.buffer).setUint32(33, 0xffffffff);
    rejects(broken);
    rejects(imageBytes(png.subarray(0, 33), png.subarray(8, 33), png.subarray(33)));
    rejects(imageBytes(png.subarray(0, 33), pngChunk("IEND", new Uint8Array())));
    for (let end = 4; end < png.length; end++) rejects(png.subarray(0, end));
  });

  test("WebP strips EXIF/XMP/unknown odd-sized chunks, clears flags, fixes RIFF length, and retains codec bytes", async () => {
    const webp = await new Bun.Image(tinyPng()).webp().bytes();
    const extended = new Uint8Array([0x0c, 0, 0, 0, 2, 0, 0, 1, 0, 0]);
    const input = webpRiff(
      riffChunk("VP8X", extended),
      webp.subarray(12),
      riffChunk("EXIF", cameraExif()),
      riffChunk("XMP ", imageText("GPS")),
      riffChunk("JUNK", imageText("device")),
    );
    const out = stripImageMetadata(imageBytes(input, imageText("polyglot")));
    expect(out[20]).toBe(0);
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
    expect(out.subarray(30)).toEqual(webp.subarray(12));
    for (const text of ["Exif", "XMP", "GPS", "JUNK", "polyglot"]) expect(contains(out, text)).toBe(false);
    expect(await new Bun.Image(out).png().bytes()).toEqual(await new Bun.Image(webp).png().bytes());
    for (let end = 12; end < input.length; end++) rejects(input.subarray(0, end));
    rejects(webpRiff(riffChunk("EXIF", cameraExif())));
    rejects(webpRiff(riffChunk("VP8X", new Uint8Array(9)), webp.subarray(12)));
  });

  test("animated WebP frames and colour/alpha chunks survive; nested metadata is removed and bad frame bounds fail", async () => {
    const webp = await new Bun.Image(tinyPng()).webp().bytes();
    const vp8x = new Uint8Array([0x3e, 0, 0, 0, 2, 0, 0, 1, 0, 0]);
    const animation = riffChunk("ANIM", new Uint8Array(6));
    const frameHeader = new Uint8Array([0, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 0, 100, 0, 0, 0]);
    const alpha = riffChunk("ALPH", new Uint8Array([0, 255, 255, 255, 255, 255, 255]));
    const icc = riffChunk("ICCP", imageText("colour profile"));
    const frame = riffChunk("ANMF", imageBytes(frameHeader, alpha, riffChunk("EXIF", cameraExif()), webp.subarray(12)));
    const input = webpRiff(riffChunk("VP8X", vp8x), icc, animation, frame, frame);
    const out = stripImageMetadata(input);
    expect(contains(out, "Exif")).toBe(false);
    expect(Buffer.from(out).includes(Buffer.from(icc))).toBe(true);
    expect(Buffer.from(out).includes(Buffer.from(alpha))).toBe(true);
    const flags = vp8x.slice();
    flags[0] = 0x32;
    const cleanFrame = riffChunk("ANMF", imageBytes(frameHeader, alpha, webp.subarray(12)));
    expect(out).toEqual(webpRiff(riffChunk("VP8X", flags), icc, animation, cleanFrame, cleanFrame));
    const brokenFrame = imageBytes(frameHeader, webp.subarray(12));
    new DataView(brokenFrame.buffer).setUint32(20, 0xffffffff, true);
    rejects(webpRiff(riffChunk("VP8X", vp8x), animation, riffChunk("ANMF", brokenFrame)));
  });

  test("HEIC, AVIF, TIFF, GIF, BMP, SVG, video and unknown bytes pass through by identity", () => {
    for (const magic of [
      "\0\0\0\x18ftypheic",
      "\0\0\0\x18ftypavif",
      "II*\0",
      "GIF89a",
      "BM",
      "<svg/>",
      "\0\0\0\x18ftypmp42",
      "unknown",
      "",
    ]) {
      const bytes = imageText(magic);
      expect(stripImageMetadata(bytes)).toBe(bytes);
    }
  });
});

test("data URL parameters, case, percent encoding and forgiving base64 cannot bypass stripping", async () => {
  const jpeg = await tinyJpeg();
  const camera = withCameraMetadata(jpeg, 1);
  const base64 = Buffer.from(camera).toString("base64");
  const expected = `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;
  expect(base64).toMatch(/=$/);
  const bodies = [base64, base64.replace(/=+$/, ""), base64.replace(/.{1,60}/g, "$&\r\n ")];
  for (const prefix of [
    "data:image/jpeg;name=photo.jpg;base64,",
    "data:image/jpeg;charset=utf-8;base64,",
    "DATA:image/jpeg;base64,",
    "data:IMAGE/JPEG;base64,",
    "data:image/jpeg; BASE64 \t,",
    "data:image/jpeg;base64,",
  ])
    for (const body of bodies) expect(stripImageDataUrlMetadata(prefix + body)).toBe(expected);
  // Browsers ignore surrounding spaces, embedded tabs or newlines, and the fragment of an image source.
  for (const value of [` data:image/jpeg;base64,${base64}`, `da\nta:image/jpeg;base64,${base64}`, `data:image/jpeg;base64,${base64}#gps`])
    expect(stripImageDataUrlMetadata(value)).toBe(expected);
  const percentBody = Array.from(camera, (byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  expect(stripImageDataUrlMetadata(`data:image/jpeg,${percentBody}`)).toBe(expected);
  // Magic bytes own classification even when the declared MIME is unrelated.
  expect(stripImageDataUrlMetadata(`data:APPLICATION/OCTET-STREAM;base64,${base64}`)).toBe(
    expected.replace("image/jpeg", "application/octet-stream"),
  );
  for (const value of [
    "https://example.test/photo.jpg",
    "data:image/jpeg;base64",
    "data:image/svg+xml,%ZZ<svg/>",
    `data:image/svg+xml;base64, ${Buffer.from("<svg />").toString("base64").replace(/=+$/, "")}\n`,
  ])
    expect(stripImageDataUrlMetadata(value)).toBe(value);
  for (const body of ["%%%", "A", "AAAA=", "AA===", "AA-_", "AA\vAA"])
    expect(() => stripImageDataUrlMetadata(`data:image/jpeg;base64,${body}`)).toThrow(ImageMetadataError);
});

test("discarded EXIF tags and pointers do not reject renderable JPEGs", async () => {
  const jpeg = await tinyJpeg();
  for (const orientation of [0, 9, 65535]) expect(stripImageMetadata(withCameraMetadata(jpeg, orientation))).toEqual(jpeg);
  for (const mutate of [
    (view: DataView) => view.setUint16(30, 13), // Unrelated Make type.
    (view: DataView) => view.setUint32(36, 0xffffffff), // Unrelated Make value offset.
    (view: DataView) => view.setUint32(52, 0xffffffff), // Next IFD pointer.
  ]) {
    const exif = cameraExif();
    mutate(new DataView(exif.buffer));
    expect(orientationOf(stripImageMetadata(imageBytes(jpeg.subarray(0, 2), jpegSegment(0xe1, exif), jpeg.subarray(2))))).toBe(6);
  }
  expect(stripImageMetadata(imageBytes(jpeg.subarray(0, 2), new Uint8Array([0, 0]), jpeg.subarray(2)))).toEqual(jpeg);
  expect(stripImageMetadata(imageBytes(jpeg.subarray(0, 2), jpegSegment(0xe1, imageText("Exif\0X")), jpeg.subarray(2)))).toEqual(jpeg);
});

test("JFIF ignores trailing padding and writes only the thumbnail-free header", async () => {
  const jpeg = await tinyJpeg();
  const header = imageBytes(imageText("JFIF\0"), new Uint8Array([1, 1, 0, 0, 1, 0, 1, 0, 0]));
  const out = stripImageMetadata(
    imageBytes(jpeg.subarray(0, 2), jpegSegment(0xe0, imageBytes(header, new Uint8Array([13, 14]))), jpeg.subarray(2)),
  );
  expect(out).toEqual(imageBytes(jpeg.subarray(0, 2), jpegSegment(0xe0, header), jpeg.subarray(2)));
  expect(new DataView(out.buffer, out.byteOffset).getUint16(4)).toBe(16);
});

const repeat = (part: Uint8Array, count: number): Uint8Array => {
  const out = new Uint8Array(part.length * count);
  for (let offset = 0; offset < out.length; offset += part.length) out.set(part, offset);
  return out;
};

test("100k JPEG segments retain codec segments in order and drop interleaved comments", async () => {
  const jpeg = await tinyJpeg();
  const kept = new Uint8Array([255, 196, 0, 2]);
  const input = imageBytes(jpeg.subarray(0, 2), repeat(imageBytes(kept, jpegSegment(0xfe, imageText("GPS"))), 100_000), jpeg.subarray(2));
  const out = stripImageMetadata(input);
  expect(out).toEqual(imageBytes(jpeg.subarray(0, 2), repeat(kept, 100_000), jpeg.subarray(2)));
  expect(out.length).toBeLessThanOrEqual(input.length + 36);
});

test("100k PNG chunks retain transparency chunks in order and drop interleaved text", () => {
  const png = tinyPng();
  const kept = pngChunk("tRNS", new Uint8Array());
  const input = imageBytes(png.subarray(0, 33), repeat(imageBytes(kept, pngChunk("tEXt", imageText("GPS"))), 100_000), png.subarray(33));
  const out = stripImageMetadata(input);
  expect(out).toEqual(imageBytes(png.subarray(0, 33), repeat(kept, 100_000), png.subarray(33)));
  expect(out.length).toBeLessThanOrEqual(input.length);
});

test("100k WebP ICC chunks retain their order with canonical RIFF length and VP8X flags", () => {
  const flags = new Uint8Array([0x2c, 0, 0, 0, 2, 0, 0, 1, 0, 0]);
  const kept = repeat(riffChunk("ICCP", new Uint8Array([1])), 100_000);
  const codec = riffChunk("VP8L", new Uint8Array([47, 0, 0, 0, 0]));
  const input = webpRiff(riffChunk("VP8X", flags), kept, codec, riffChunk("XMP ", imageText("GPS")));
  flags[0] = 0x20;
  const out = stripImageMetadata(input);
  expect(out).toEqual(webpRiff(riffChunk("VP8X", flags), kept, codec));
  expect(out[20]).toBe(0x20);
  expect(new DataView(out.buffer, out.byteOffset).getUint32(4, true)).toBe(out.length - 8);
  expect(out.length).toBeLessThanOrEqual(input.length);
});
