import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import * as canvasWorker from "../../_internal/canvas-worker";
import { readImageRecords } from "./image-protocol";
import { PDF_IMAGE_MAX_INPUT_BYTES, type PdfImageVariant, type PreparePdfImageResult, preparePdfImage } from "./image";

const runtime = process.platform === "linux" ? describe : describe.skip;
const originalSpawn = canvasWorker.spawnCanvasWorker;
const spawn = spyOn(canvasWorker, "spawnCanvasWorker");
afterAll(() => spawn.mockRestore());
beforeEach(() => spawn.mockClear());
const box = { width: 2008, height: 2900 };
const cap = 4 * 1024 * 1024;
let webp: Buffer;

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

runtime("preparePdfImage", () => {
  beforeAll(async () => {
    webp = await sharp(pixels(2000, 1500), { raw: { width: 2000, height: 1500, channels: 3 } })
      .webp()
      .toBuffer();
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
    expect(
      await preparePdfImage({ data: Bun.file(new URL("./fixtures/photo.heic", import.meta.url)), boxes: [box], maxBytes: cap }),
    ).toEqual({ ok: false, code: "unsupported_format" });
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
        ["PATH", "LANG", "UV_THREADPOOL_SIZE", "TOKIO_WORKER_THREADS", "BUN_JSC_numberOfGCMarkers"].sort(),
      );
    } finally {
      bunSpawn.mockRestore();
      if (previous === undefined) delete process.env.CLOUD_TEST_FAKE_SECRET;
      else process.env.CLOUD_TEST_FAKE_SECRET = previous;
    }
  }, 30_000);

  test("rejects oversized input and pre-abort without spawning; validates programming errors", async () => {
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
    const runs = [0, 1].map(() => preparePdfImage({ data: new StalledBlob([new Uint8Array(webp)]), boxes: [box], maxBytes: cap }, { timeoutMs: 100 }));
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
        const counts = new Map<string, number>();
        if (child?.type === "return") {
          try {
            for (const tid of readdirSync(`/proc/${child.value.pid}/task`)) {
              const name = readFileSync(`/proc/${child.value.pid}/task/${tid}/comm`, "utf8").trim().replace(/ \d+$/, "");
              counts.set(name, (counts.get(name) ?? 0) + 1);
            }
          } catch {} // A thread can exit during sampling.
          for (const [name, count] of counts) peak.set(name, Math.max(peak.get(name) ?? 0, count));
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
