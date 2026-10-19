import { expect, test } from "bun:test";
import { chooseEncoding, compressBody, encodeStream, isCompressionEligible } from "./compression";

test.each([
  [null, null],
  ["", null],
  ["identity", null],
  ["br, gzip", "br"],
  ["gzip;q=0.9, br;q=0.8", "gzip"],
  ["br;q=0.5, gzip;q=0.5", "br"],
  ["*;q=0.7", "br"],
  ["br;q=0, *;q=1", "gzip"],
  ["gzip;q=0, *;q=0.4", "br"],
  ["br;q=0, gzip;q=0", null],
  ["x-gzip", "gzip"],
  ["BR;Q=1, GZip;q=0.123", "br"],
  ["br;q=broken, gzip", "gzip"],
  ["br;q=1.001", null],
  ["br;q=-0.1", null],
  ["br;q=0.1234", null],
  ["br;q=.5", null],
  ["br;q=2", null],
  ["br;q=0.000, gzip;q=0.001", "gzip"],
  ["br;q=0.5;invalid, gzip;q=0.1", "gzip"],
  ["identity;q=1, br;q=0.1, gzip;q=0", null],
  ["identity;q=0.5, gzip;q=0.6", "gzip"],
  ["br, identity", "br"],
] as const)("negotiates %s as %s", (header, expected) => expect(chooseEncoding(header)).toBe(expected));

test("eligibility handles absent bodies, informational status, and exact directives", () => {
  const headers = new Headers({ "Content-Type": " Text/HTML ; charset=utf-8" });
  expect(isCompressionEligible("GET", 200, false, headers)).toBe(false);
  expect(isCompressionEligible("GET", 103, true, headers)).toBe(false);
  for (const cacheControl of ["private, No-Transform", "no-transform", "max-age=0, no-transform, private"]) {
    headers.set("Cache-Control", cacheControl);
    expect(isCompressionEligible("GET", 200, true, headers)).toBe(false);
  }
  for (const cacheControl of ["x-no-transform", "no-transform-extra", 'extension="x,no-transform,y"']) {
    headers.set("Cache-Control", cacheControl);
    expect(isCompressionEligible("GET", 200, true, headers)).toBe(true);
  }
  headers.set("Content-Encoding", "");
  expect(isCompressionEligible("GET", 200, true, headers)).toBe(false);
});

test.each(["br", "gzip"] as const)("%s propagates upstream errors", async (encoding) => {
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("upstream body failed"));
    },
  });
  await expect(new Response(encodeStream(source, encoding, undefined)).arrayBuffer()).rejects.toThrow("upstream body failed");
});

test.each(["br", "gzip"] as const)("%s cancellation cancels a pending upstream read", async (encoding) => {
  const cancelled = Promise.withResolvers<unknown>();
  const source = new ReadableStream<Uint8Array>({
    cancel(reason) {
      cancelled.resolve(reason);
    },
  });
  const output = encodeStream(source, encoding, undefined);
  await output.cancel();
  await cancelled.promise;
  expect(source.locked).toBe(false);
});

test.each(["br", "gzip"] as const)("%s flushes a chunk while the upstream remains open", async (encoding) => {
  const { brotliDecompressSync, gunzipSync, constants } = await import("node:zlib");
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from("<p>visible before upstream ends</p>"));
    },
  });
  const output = encodeStream(source, encoding, undefined).getReader();
  try {
    const first = await output.read();
    expect(first.done).toBe(false);
    const bytes: Uint8Array[] = [];
    if (first.value) bytes.push(first.value);
    let text = "";
    while (!text.includes("</p>")) {
      const data = Buffer.concat(bytes);
      text =
        encoding === "br"
          ? brotliDecompressSync(data, { finishFlush: constants.BROTLI_OPERATION_FLUSH }).toString()
          : gunzipSync(data, { finishFlush: constants.Z_SYNC_FLUSH }).toString();
      if (text.includes("</p>")) break;
      const next = await output.read();
      if (next.done) throw new Error("Encoder ended before upstream");
      bytes.push(next.value);
    }
    expect(text).toBe("<p>visible before upstream ends</p>");
  } finally {
    await output.cancel();
  }
});

test.each(["br", "gzip"] as const)("%s cancellation releases a backpressured encoder", async (encoding) => {
  const cancelled = Promise.withResolvers<void>();
  // Deterministic bytes that remain large after encoding, filling zlib's buffer.
  const bytes = Buffer.alloc(1024 * 1024);
  let seed = 12345;
  for (let i = 0; i < bytes.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    bytes[i] = seed >>> 24;
  }
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      cancelled.resolve();
    },
  });
  const reader = encodeStream(source, encoding, bytes.length).getReader();
  expect((await reader.read()).done).toBe(false);
  await reader.cancel();
  await cancelled.promise;
  expect(source.locked).toBe(false);
});

test.each([null, "identity", "br;q=0, gzip;q=0"])("eligible identity (%s) adds Vary without changing the body", async (accept) => {
  const response = new Response("x".repeat(2048), { headers: { "Content-Type": "text/html", Vary: "Cookie", ETag: '"strong"' } });
  const headers = new Headers(response.headers);
  const result = compressBody(
    new Request("http://cloud.test/", { headers: accept === null ? {} : { "Accept-Encoding": accept } }),
    response,
    headers,
  );
  expect(result).toBe(response.body);
  expect(headers.get("Vary")).toBe("Cookie, Accept-Encoding, Sec-Fetch-Site, Sec-Fetch-Dest");
  expect(headers.get("ETag")).toBe('"strong"');
  expect(headers.has("Content-Encoding")).toBe(false);
  expect(await new Response(result).text()).toBe("x".repeat(2048));
});
