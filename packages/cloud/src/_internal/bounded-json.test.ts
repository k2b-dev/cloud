import { describe, expect, test } from "bun:test";
import { readBoundedJson } from "./bounded-json";

describe("readBoundedJson", () => {
  test("parses JSON within the actual byte limit", async () => {
    const result = await readBoundedJson(new Request("http://cloud.test", { method: "POST", body: '{"ok":true}' }), 32);
    expect(result).toEqual({ ok: true, data: { ok: true } });
  });

  test("rejects invalid and streamed oversized JSON", async () => {
    expect(await readBoundedJson(new Response("{"), 32)).toEqual({ ok: false, reason: "invalid_json" });
    expect(await readBoundedJson(new Response(JSON.stringify({ value: "x".repeat(64) })), 32)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  test("cancels a body rejected from its declared size", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { headers: { "content-length": "100" } });

    expect(await readBoundedJson(response, 32)).toEqual({ ok: false, reason: "too_large" });
    expect(cancelled).toBeTrue();
  });

  test("rejects invalid UTF-8 and body stream failures", async () => {
    expect(await readBoundedJson(new Response(new Uint8Array([0x7b, 0xff, 0x7d])), 32)).toEqual({
      ok: false,
      reason: "invalid_json",
    });
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket closed"));
      },
    });
    expect(await readBoundedJson(new Response(broken), 32)).toEqual({ ok: false, reason: "invalid_json" });
  });
});
