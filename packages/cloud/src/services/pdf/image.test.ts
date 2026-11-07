import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import * as canvasWorker from "../../_internal/canvas-worker";
import { PDF_IMAGE_MAX_INPUT_BYTES, type PdfImageVariant, type PreparePdfImageResult, preparePdfImage } from "./image";
import { readImageFrame, readImageRecords } from "./image-protocol";

const runtime = process.platform === "linux" ? describe : describe.skip;
const originalSpawn = canvasWorker.spawnCanvasWorker;
const spawn = spyOn(canvasWorker, "spawnCanvasWorker");
afterAll(() => spawn.mockRestore());
beforeEach(() => spawn.mockClear());
const box = { width: 2008, height: 2900 };
const cap = 4 * 1024 * 1024;
let webp: Buffer;
let oversizedWebp: Buffer;
let rotatedJpeg: Buffer;
let transparentWebp: Buffer;
let truncatedJpeg: Buffer;
const HEIC_BASE64 =
  "AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAX1tZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABoQABAAAAAAAAAEkAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA/WlwcnAAAADdaXBjbwAAAHZodmNDAQNwAAAAkAAAAAAAHvAA/P34+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbq5Ka5uAhoMCAAAAMDIAAAAwAhYgABAAZEAcFzwIkAAAATY29scm5jbHgAAQANAAaAAAAAFGlzcGUAAAAAAAAAQAAAAEAAAAAoY2xhcAAAADAAAAABAAAAIAAAAAH////wAAAAAv///+AAAAACAAAAEHBpeGkAAAAAAwgICAAAABhpcG1hAAAAAAAAAAEAAQWBAgMFhAAAAFFtZGF0AAAARSgBr1jm+TodPuUbcCF5OoqkgneBYwmcDw33y4hfAewzkkwm3VY53EA95IHpB61vei/srL0XacJAbIWwgNtXlkJqmRs//g==";

/** Fixed gradient and integer noise; no random generator or wall-clock fixtures. */
function pixels(width: number, height: number) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      data[offset] = (x * 7 + y * 13) % 256;
      data[offset + 1] = Math.floor((x * 255) / width);
      data[offset + 2] = Math.floor((y * 255) / height);
    }
  }
  return data;
}

function variants(result: PreparePdfImageResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  return result.variants;
}
function variant(result: PreparePdfImageResult): PdfImageVariant {
  const image = variants(result)[0];
  expect(image).toBeTruthy();
  if (!image) throw new Error("Missing image");
  return image;
}
const bytes = async (image: PdfImageVariant) => Buffer.from(await image.data.arrayBuffer());

function countThreadNames(names: string[]) {
  const counts = new Map<string, number>();
  const bunWorkers = new Set<string>();
  for (const rawName of names) {
    // Linux children inherit their creator's name until they set their own.
    // Bun assigns a unique numeric name to each actual pool worker.
    if (/^Bun Pool \d+$/.test(rawName)) {
      if (bunWorkers.has(rawName)) continue;
      bunWorkers.add(rawName);
    }
    const name = rawName.replace(/ \d+$/, "");
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

describe("decoder thread sampling", () => {
  test("does not count a libvips child inheriting its Bun worker's name as another Bun worker", () => {
    const counts = countThreadNames(["Bun Pool 0", "Bun Pool 1", "Bun Pool 1", "libvips worker", "libvips worker", "HeapHelper"]);
    expect(Object.fromEntries(counts)).toEqual({ "Bun Pool": 2, "libvips worker": 2, HeapHelper: 1 });
  });

  test("still counts a third distinct Bun worker", () => {
    expect(countThreadNames(["Bun Pool 0", "Bun Pool 1", "Bun Pool 2"]).get("Bun Pool")).toBe(3);
  });
});

function oversizedPng() {
  const chunk = (name: string, data: Buffer) => {
    const content = Buffer.concat([Buffer.from(name), data]);
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    content.copy(out, 4);
    out.writeUInt32BE(crc32(content), out.length - 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(20000, 0);
  ihdr.writeUInt32BE(20000, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.alloc(4096))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const stream = (data: string | Uint8Array, size = 7) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + size));
      offset = Math.min(offset + size, bytes.length);
    },
  });
};

runtime("preparePdfImage", () => {
  beforeAll(async () => {
    webp = await sharp(pixels(2000, 1500), { raw: { width: 2000, height: 1500, channels: 3 } })
      .webp()
      .toBuffer();
    oversizedWebp = await sharp({ create: { width: 10000, height: 10000, channels: 3, background: "red" } })
      .webp()
      .toBuffer();
    rotatedJpeg = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: "red" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    transparentWebp = await sharp({ create: { width: 4000, height: 3000, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0.5 } } })
      .webp()
      .toBuffer();
    const jpeg = await sharp(pixels(800, 600), { raw: { width: 800, height: 600, channels: 3 } })
      .jpeg()
      .toBuffer();
    truncatedJpeg = jpeg.subarray(0, Math.floor(jpeg.byteLength / 3));
  }, 120_000);

  test("rejects a 10000x10000 WebP above the source pixel limit as too_large", async () => {
    expect(await preparePdfImage({ data: oversizedWebp, boxes: [box], maxBytes: cap }, { timeoutMs: 90_000 })).toEqual({
      ok: false,
      code: "too_large",
    });
  }, 120_000);

  test("fits an 8000x6000 JPEG with EXIF orientation 6 as an upright portrait", async () => {
    expect((await sharp(rotatedJpeg).metadata()).orientation).toBe(6);
    const image = variant(await preparePdfImage({ data: rotatedJpeg, boxes: [box], maxBytes: cap }, { timeoutMs: 90_000 }));
    expect([image.type, image.width, image.height]).toEqual(["image/jpeg", 2008, 2677]);
    const metadata = await sharp(await bytes(image)).metadata();
    expect([metadata.format, metadata.width, metadata.height, metadata.orientation]).toEqual(["jpeg", 2008, 2677, undefined]);
  }, 120_000);

  test("fits a 4000x3000 transparent WebP as PNG within the real worker memory limit", async () => {
    const result = await preparePdfImage({ data: transparentWebp, boxes: [box], maxBytes: cap }, { timeoutMs: 90_000 });
    const image = variant(result);
    expect([image.type, image.width, image.height]).toEqual(["image/png", 2008, 1506]);
    const decoded = await sharp(await bytes(image))
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(decoded.info.channels).toBe(4);
    expect(decoded.data[3]).toBeGreaterThan(0);
    expect(decoded.data[3]).toBeLessThan(255);
  }, 120_000);

  test("rejects a fitting JPEG truncated to one third instead of passing it through", async () => {
    expect(await preparePdfImage({ data: truncatedJpeg, boxes: [box], maxBytes: cap })).toEqual({ ok: false, code: "unreadable" });
  }, 30_000);

  test("fits an opaque WebP without enlargement and emits bounded JPEG", async () => {
    const image = variant(await preparePdfImage({ data: webp, boxes: [box], maxBytes: cap }));
    expect([image.type, image.width, image.height]).toEqual(["image/jpeg", 2000, 1500]);
    expect(image.data.size).toBeLessThanOrEqual(cap);
    expect(image.data.type).toBe(image.type);
    const metadata = await sharp(await bytes(image)).metadata();
    expect([metadata.format, metadata.space, metadata.depth]).toEqual(["jpeg", "srgb", "uchar"]);
  }, 30_000);

  test("keeps real transparency, while a fully opaque alpha channel becomes JPEG", async () => {
    for (const alpha of [0, 255]) {
      const rgba = Buffer.from([255, 0, 0, alpha, 0, 255, 0, 255]);
      const png = await sharp(rgba, { raw: { width: 2, height: 1, channels: 4 } })
        .png()
        .toBuffer();
      const image = variant(await preparePdfImage({ data: new Blob([png]), boxes: [box], maxBytes: cap }));
      expect(image.type).toBe(alpha === 0 ? "image/png" : "image/jpeg");
      const result = await sharp(await bytes(image))
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(result.info.channels).toBe(alpha === 0 ? 4 : 3);
      if (alpha === 0) expect(result.data[3]).toBe(0);
    }
  }, 30_000);

  test("passes through fitting upright JPEG bytes exactly", async () => {
    const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: "red" } })
      .jpeg()
      .toBuffer();
    const image = variant(await preparePdfImage({ data: jpeg, boxes: [box], maxBytes: cap }));
    expect([image.width, image.height, image.type]).toEqual([300, 200, "image/jpeg"]);
    expect(await bytes(image)).toEqual(jpeg);
  }, 30_000);

  test("applies EXIF orientation before fitting and re-encodes rotated JPEG", async () => {
    const jpeg = await sharp({ create: { width: 300, height: 200, channels: 3, background: "red" } })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const image = variant(await preparePdfImage({ data: jpeg, boxes: [box], maxBytes: cap }));
    expect([image.width, image.height]).toEqual([200, 300]);
    expect(await bytes(image)).not.toEqual(jpeg);
    expect((await sharp(await bytes(image)).metadata()).orientation).toBeUndefined();
  }, 30_000);

  test("rejects oversized pixel headers cleanly, unidentified bytes and HEVC", async () => {
    expect(await preparePdfImage({ data: oversizedPng(), boxes: [box], maxBytes: cap })).toEqual({ ok: false, code: "too_large" });
    expect(await preparePdfImage({ data: Buffer.from("not an image"), boxes: [box], maxBytes: cap })).toEqual({
      ok: false,
      code: "unreadable",
    });
    expect(await preparePdfImage({ data: Buffer.from(HEIC_BASE64, "base64"), boxes: [box], maxBytes: cap })).toEqual({
      ok: false,
      code: "unsupported_format",
    });
  }, 30_000);

  test.each([
    ["truncated body", '{"index":0,"type":"image/png","width":2,"height":1,"bytes":3}\nxy', "unreadable"],
    ["extra final record", '{"ok":true}\n{"ok":true}\n', "unreadable"],
    ["malformed record", "nope\n", "unreadable"],
    [
      "failure after a variant",
      '{"index":0,"type":"image/png","width":2,"height":1,"bytes":3}\nxyz{"ok":false,"code":"too_large"}\n',
      "too_large",
    ],
  ] as const)("handles worker %s without returning partial variants", async (_name, output, code) => {
    spawn.mockImplementationOnce((_worker, _name, input) =>
      Bun.spawn([process.execPath, "--no-env-file", "-e", `process.stdout.write(${JSON.stringify(output)})`], {
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "ignore",
        env: { PATH: process.env.PATH },
      }),
    );
    expect(await preparePdfImage({ data: webp, boxes: [box], maxBytes: cap })).toEqual({ ok: false, code });
  });

  test("returns three ordered variants using exactly one worker", async () => {
    const result = variants(
      await preparePdfImage({ data: webp, boxes: [1600, 800, 400].map((width) => ({ width, height: 2000 })), maxBytes: cap }),
    );
    expect(result.map((image) => image && [image.width, image.height])).toEqual([
      [1600, 1200],
      [800, 600],
      [400, 300],
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
  }, 30_000);

  test("keeps a smaller encoding when another box exceeds maxBytes", async () => {
    const result = variants(await preparePdfImage({ data: webp, boxes: [box, { width: 8, height: 8 }], maxBytes: 1000 }));
    expect(result[0]).toBeNull();
    expect(result[1]?.data.size).toBeLessThanOrEqual(1000);
    expect([result[1]?.width, result[1]?.height]).toEqual([8, 6]);
  }, 30_000);

  test("kills and reaps a child before abort or deadline resolves", async () => {
    const original = originalSpawn;
    for (const mode of ["abort", "deadline"] as const) {
      const controller = new AbortController();
      let pid: number | undefined;
      spawn.mockImplementationOnce((...args) => {
        const child = original(...args);
        pid = child.pid;
        if (mode === "abort") setTimeout(() => controller.abort(), 150);
        return child;
      });
      const result = await preparePdfImage(
        { data: webp, boxes: [box], maxBytes: cap },
        { signal: controller.signal, timeoutMs: mode === "deadline" ? 5 : 30_000 },
      );
      expect(result).toEqual({ ok: false, code: "timed_out" });
      expect(pid).toBeNumber();
      try {
        process.kill(pid!, 0);
        throw new Error("Worker survived its promise");
      } catch (error) {
        expect(error).toHaveProperty("code", "ESRCH");
      }
    }
  }, 30_000);

  test("passes only the launcher's fixed environment into the child", async () => {
    const previous = process.env.CLOUD_TEST_FAKE_SECRET;
    process.env.CLOUD_TEST_FAKE_SECRET = "must-not-reach-worker";
    const bunSpawn = spyOn(Bun, "spawn");
    try {
      variant(await preparePdfImage({ data: webp, boxes: [{ width: 8, height: 8 }], maxBytes: cap }));
      expect(bunSpawn.mock.calls).toHaveLength(1);
      expect(Object.keys(bunSpawn.mock.calls[0]![1]!.env!).sort()).toEqual(
        ["PATH", "LANG", "UV_THREADPOOL_SIZE", "TOKIO_WORKER_THREADS", "BUN_JSC_numberOfGCMarkers", "MIMALLOC_ARENA_EAGER_COMMIT"].sort(),
      );
    } finally {
      bunSpawn.mockRestore();
      if (previous === undefined) delete process.env.CLOUD_TEST_FAKE_SECRET;
      else process.env.CLOUD_TEST_FAKE_SECRET = previous;
    }
  }, 30_000);

  test("rejects oversized input and pre-abort without spawning; validates programming errors", async () => {
    expect(PDF_IMAGE_MAX_INPUT_BYTES).toBe(32 * 1024 * 1024);
    expect(await preparePdfImage({ data: new Uint8Array(PDF_IMAGE_MAX_INPUT_BYTES + 1), boxes: [box], maxBytes: cap })).toEqual({
      ok: false,
      code: "too_large",
    });
    expect(await preparePdfImage({ data: webp, boxes: [box], maxBytes: cap }, { signal: AbortSignal.abort() })).toEqual({
      ok: false,
      code: "timed_out",
    });
    for (const boxes of [[], Array(9).fill(box), [{ width: 0, height: 1 }], [{ width: 16384, height: 1 }], [{ width: 1.1, height: 2 }]]) {
      await expect(preparePdfImage({ data: webp, boxes, maxBytes: cap })).rejects.toThrow();
    }
    for (const maxBytes of [0, 1.5, PDF_IMAGE_MAX_INPUT_BYTES + 1])
      await expect(preparePdfImage({ data: webp, boxes: [box], maxBytes })).rejects.toThrow();
    for (const timeoutMs of [0, 1.5, 240001])
      await expect(preparePdfImage({ data: webp, boxes: [box], maxBytes: cap }, { timeoutMs })).rejects.toThrow();
    expect(spawn).toHaveBeenCalledTimes(0);
  }, 30_000);

  test("a Blob that never finishes reading times out at the deadline and frees its slot", async () => {
    class StalledBlob extends Blob {
      override arrayBuffer() {
        return new Promise<ArrayBuffer>(() => {});
      }
    }
    const runs = [0, 1].map(() =>
      preparePdfImage({ data: new StalledBlob([new Uint8Array(webp)]), boxes: [box], maxBytes: cap }, { timeoutMs: 100 }),
    );
    expect(await Promise.all(runs)).toEqual([
      { ok: false, code: "timed_out" },
      { ok: false, code: "timed_out" },
    ]);
    expect(spawn).toHaveBeenCalledTimes(0);
    variant(await preparePdfImage({ data: webp, boxes: [{ width: 8, height: 8 }], maxBytes: cap }));
  }, 30_000);

  test("bounds active workers at two, keeps FIFO order, and aborts queued work", async () => {
    const original = originalSpawn;
    const order: number[] = [];
    let live = 0;
    let peak = 0;
    const observed: Promise<number>[] = [];
    spawn.mockImplementation((worker, name, input) => {
      if (input instanceof Blob)
        observed.push(
          input
            .slice(0, 200)
            .text()
            .then((text) => JSON.parse(text.split("\n")[0]!).boxes[0].width),
        );
      const child = original(worker, name, input);
      order.push(child.pid);
      peak = Math.max(peak, ++live);
      child.exited.then(() => live--);
      return child;
    });
    const abort = new AbortController();
    try {
      const runs = [1600, 1200, 1000, 800, 600, 500].map((width, index) =>
        preparePdfImage(
          { data: webp, boxes: [{ width, height: 2000 }], maxBytes: cap },
          index === 2 ? { signal: abort.signal } : index === 5 ? { timeoutMs: 5 } : {},
        ),
      );
      await Promise.resolve();
      expect(order.length).toBe(2);
      abort.abort();
      const result = await Promise.all(runs);
      expect(result.map((entry) => (entry.ok ? "ok" : entry.code))).toEqual(["ok", "ok", "timed_out", "ok", "ok", "timed_out"]);
      expect(await Promise.all(observed)).toEqual([1600, 1200, 800, 600]);
      expect(peak).toBe(2);
      expect(live).toBe(0);
    } finally {
      spawn.mockImplementation(original);
    }
  }, 60_000);
  test("keeps fixed decoder thread pools independent of host core count", async () => {
    const peak = new Map<string, number>();
    let finished = false;
    const pending = preparePdfImage({ data: webp, boxes: [box], maxBytes: cap }).finally(() => {
      finished = true;
    });
    try {
      while (!finished) {
        const child = spawn.mock.results[0];
        const names: string[] = [];
        if (child?.type === "return") {
          try {
            for (const tid of readdirSync(`/proc/${child.value.pid}/task`)) {
              names.push(readFileSync(`/proc/${child.value.pid}/task/${tid}/comm`, "utf8").trim());
            }
          } catch {} // A thread can exit during sampling.
          for (const [name, count] of countThreadNames(names)) peak.set(name, Math.max(peak.get(name) ?? 0, count));
        }
        await Bun.sleep(1);
      }
      variant(await pending);
      // libvips names its own worker and can also name the two calling libuv threads.
      expect(peak.get("libvips worker")).toBeGreaterThan(0);
      expect(peak.get("libvips worker")).toBeLessThanOrEqual(3);
      expect(peak.get("Bun Pool")).toBeGreaterThan(0);
      expect(peak.get("Bun Pool")).toBeLessThanOrEqual(2);
      expect(peak.get("HeapHelper")).toBe(1);
    } finally {
      await pending;
    }
  }, 30_000);
});

describe("image record protocol", () => {
  const request = {
    boxes: [
      { width: 8, height: 8 },
      { width: 8, height: 8 },
      { width: 8, height: 8 },
    ],
    maxBytes: 32,
  };
  const header = { index: 0, type: "image/png", width: 2, height: 1, bytes: 3 };
  const line = (record: unknown) => `${JSON.stringify(record)}\n`;
  const success = line({ ok: true });
  const record = `${line(header)}abc`;
  test.each([1, 7, 4096])("reads headers and binary bodies across chunks of %i bytes, preserving box order and nulls", async (size) => {
    const binary = Buffer.from('\n{"ok":true}\n');
    const output = Buffer.concat([Buffer.from(line({ ...header, index: 2, bytes: binary.length })), binary, Buffer.from(record + success)]);
    const result = await readImageRecords(stream(output, size), request);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.code);
    expect(result.variants[1]).toBeNull();
    expect(await result.variants[0]!.data.text()).toBe("abc");
    expect(result.variants[2]).toMatchObject({ type: "image/png", width: 2, height: 1 });
    expect(Buffer.from(await result.variants[2]!.data.arrayBuffer())).toEqual(binary);
    expect(result.variants[2]!.data.type).toBe("image/png");
  });

  test.each(["unsupported_format", "unreadable", "too_large", "timed_out"])("final %s status discards earlier variants", async (code) => {
    expect(await readImageRecords(stream(record + line({ ok: false, code })), request)).toEqual({ ok: false, code });
  });

  test("a success with no variant records leaves every box null", async () => {
    expect(await readImageRecords(stream(success), request)).toEqual({ ok: true, variants: [null, null, null] });
  });

  test("accepts a JSON line exactly 4 KiB long", async () => {
    expect(await readImageRecords(stream(" ".repeat(4096 - success.length + 1) + success), request)).toEqual({
      ok: true,
      variants: [null, null, null],
    });
  });

  test.each([
    ["empty stream", ""],
    ["missing final status", record],
    ["truncated body", `${line(header)}ab`],
    ["extra body byte", `${record}d${success}`],
    ["missing final newline", record + success.trim()],
    ["missing record newline", JSON.stringify(header)],
    ["invalid JSON", "nope\n"],
    ["header longer than 4 KiB", " ".repeat(4096) + success],
    ["unterminated oversized header", " ".repeat(4097)],
    ["index outside boxes", `${line({ ...header, index: 3 })}abc${success}`],
    ["negative index", `${line({ ...header, index: -1 })}abc${success}`],
    ["fractional index", `${line({ ...header, index: 0.5 })}abc${success}`],
    ["repeated index", record + record + success],
    ["too many records", record + record + record + record + success],
    ["variant over maxBytes", line({ ...header, bytes: 33 })],
    ["zero bytes", line({ ...header, bytes: 0 })],
    ["fractional bytes", line({ ...header, bytes: 1.5 })],
    ["width outside box", line({ ...header, width: 9 })],
    ["height outside box", line({ ...header, height: 9 })],
    ["zero width", line({ ...header, width: 0 })],
    ["invalid type", line({ ...header, type: "image/webp" })],
    ["missing fields", line({ index: 0, bytes: 3 })],
    ["extra variant fields", line({ ...header, extra: true })],
    ["unknown error code", line({ ok: false, code: "unknown" })],
    ["missing error code", line({ ok: false })],
    ["extra status fields", line({ ok: true, variants: [] })],
    ["repeated final status", success + success],
    ["variant after final status", success + record],
    ["bytes after final status", success + "x"],
    ["error after final status", success + line({ ok: false, code: "too_large" })],
  ])("rejects %s", async (_name, output) => {
    await expect(readImageRecords(stream(output), request)).rejects.toThrow();
  });
});

describe("image input frame protocol", () => {
  const header = { bytes: 3, boxes: [{ width: 8, height: 8 }], maxBytes: 1000, timeoutMs: 30_000 };
  const line = (record: unknown) => `${JSON.stringify(record)}\n`;
  const read = (data: string | Uint8Array, size = 7) => {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    let position = 0;
    return (buffer: Uint8Array, offset: number, length: number) => {
      const count = Math.min(size, length, bytes.byteLength - position);
      buffer.set(bytes.subarray(position, position + count), offset);
      position += count;
      return count;
    };
  };

  test.each([1, 7, 4096])("fills the exact declared input length across reads of %i bytes", (size) => {
    const frame = readImageFrame(read(`${line(header)}abc`, size));
    expect(frame.header).toEqual(header);
    expect(frame.body).toBeInstanceOf(Uint8Array);
    expect(frame.body.buffer.byteLength).toBe(3);
    expect(new TextDecoder().decode(frame.body)).toBe("abc");
  });

  test("accepts a 4 KiB header and an empty body", () => {
    const json = JSON.stringify({ ...header, bytes: 0 });
    const frame = readImageFrame(read(`${" ".repeat(4096 - json.length)}${json}\n`));
    expect(frame.body.byteLength).toBe(0);
  });

  test.each([
    ["missing header", ""],
    ["unterminated header", JSON.stringify(header)],
    ["invalid JSON", "nope\n"],
    ["header longer than 4 KiB", `${" ".repeat(4097)}${line(header)}abc`],
    ["truncated body", `${line(header)}ab`],
    ["extra body byte", `${line(header)}abcd`],
    ["missing byte count", line({ boxes: header.boxes, maxBytes: 1000 })],
    ["negative byte count", line({ ...header, bytes: -1 })],
    ["fractional byte count", line({ ...header, bytes: 1.5 })],
    ["byte count above the input cap", line({ ...header, bytes: PDF_IMAGE_MAX_INPUT_BYTES + 1 })],
  ])("rejects %s", (_name, data) => {
    for (const size of [1, 7, 4096]) expect(() => readImageFrame(read(data, size))).toThrow();
  });
});
