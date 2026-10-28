import { expect, test } from "bun:test";
import { readAppPwaJson, untilAppPwaAbort } from "./transport-input";

const request = (body: string | ReadableStream<Uint8Array>, headers?: HeadersInit) =>
  new Request("https://cloud.example.test/app/signing/customer/_api/query/document", { method: "POST", body, headers });
const signal = () => new AbortController().signal;

test("transport accepts valid UTF-8 JSON and bounds actual bytes independently of content-length", async () => {
  expect(await readAppPwaJson(request('{"name":"ä"}'), 13, signal())).toEqual({ name: "ä" });
  await expect(readAppPwaJson(request('{"name":"ä"}', { "content-length": "1" }), 12, signal())).rejects.toMatchObject({
    code: "TOO_LARGE",
  });
  await expect(readAppPwaJson(request("{}", { "content-length": "999" }), 12, signal())).rejects.toMatchObject({ code: "TOO_LARGE" });
  for (const length of ["-1", "1.5", "unknown", "9007199254740992"])
    await expect(readAppPwaJson(request("{}", { "content-length": length }), 12, signal())).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
});

test("transport rejects malformed JSON, invalid UTF-8 and failed streams with stable codes", async () => {
  for (const text of ["", "{", "undefined", '{"x":NaN}'])
    await expect(readAppPwaJson(request(text), 100, signal())).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const invalid = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([0xff]));
      c.close();
    },
  });
  await expect(readAppPwaJson(request(invalid), 100, signal())).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const failed = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new Error("PRIVATE"));
    },
  });
  await expect(readAppPwaJson(request(failed), 100, signal())).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

test("overflow and abort never wait for a stalled stream cancellation hook", async () => {
  const stuck = () => new Promise<void>(() => {});
  const oversized = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(20));
    },
    cancel: stuck,
  });
  await expect(readAppPwaJson(request(oversized), 10, signal())).rejects.toMatchObject({ code: "TOO_LARGE" });
  const controller = new AbortController();
  const stalled = new ReadableStream<Uint8Array>({ cancel: stuck });
  const read = readAppPwaJson(request(stalled), 10, controller.signal);
  controller.abort();
  await expect(read).rejects.toMatchObject({ code: "UNAVAILABLE" });
  await expect(untilAppPwaAbort(controller.signal, stuck)).rejects.toMatchObject({ code: "UNAVAILABLE" });
});
