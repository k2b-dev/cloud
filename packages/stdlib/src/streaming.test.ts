import { describe, it, expect, spyOn } from "bun:test";
import { parseSSE, parseNDJSON } from "./streaming";
import type { SSEEvent } from "./streaming";

// ==========================
// Helpers
// ==========================

const toStream = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
};

const collect = async <T>(gen: AsyncGenerator<T>): Promise<T[]> => {
  const results: T[] = [];
  for await (const item of gen) results.push(item);
  return results;
};

// ==========================
// parseSSE
// ==========================

describe("parseSSE", () => {
  it("parses single event with data field", async () => {
    const stream = toStream(["data: hello\n\n"]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([{ data: "hello" }]);
  });

  it("parses event with event type and id", async () => {
    const stream = toStream(["event: message\nid: 42\ndata: payload\n\n"]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([{ event: "message", data: "payload", id: "42" }]);
  });

  it("handles multiline data fields (concatenated with \\n)", async () => {
    const stream = toStream(["data: line1\ndata: line2\ndata: line3\n\n"]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([{ data: "line1\nline2\nline3" }]);
  });

  it("handles data split across chunks", async () => {
    const stream = toStream(["da", "ta: hel", "lo\n\n"]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([{ data: "hello" }]);
  });

  it("skips comment lines", async () => {
    const stream = toStream([": this is a comment\ndata: real\n\n"]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([{ data: "real" }]);
  });

  it("handles CRLF line endings", async () => {
    const stream = toStream(["data: crlf\r\n\r\n"]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([{ data: "crlf" }]);
  });

  it("parses multiple events in one stream", async () => {
    const stream = toStream([
      "data: first\n\nevent: update\ndata: second\n\n",
    ]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([
      { data: "first" },
      { event: "update", data: "second" },
    ]);
  });

  it("handles empty data field", async () => {
    const stream = toStream(["data:\n\n"]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([{ data: "" }]);
  });

  it("emits final event when stream ends without trailing blank line", async () => {
    const stream = toStream(["data: no-trailing-newline"]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([{ data: "no-trailing-newline" }]);
  });

  it("ignores events with no data fields", async () => {
    const stream = toStream(["event: ping\n\ndata: real\n\n"]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([{ data: "real" }]);
  });

  it("handles data field with no space after colon", async () => {
    const stream = toStream(["data:nospace\n\n"]);
    const events = await collect(parseSSE(stream));

    expect(events).toEqual([{ data: "nospace" }]);
  });

  // Regression: CRLF split across chunk boundaries previously caused early
  // dispatch because a trailing \r was eagerly normalized to \n.
  it("does not dispatch when CRLF is split across chunks", async () => {
    const stream = toStream(["data: one\r", "\nid: 2\n\n"]);
    const events = await collect(parseSSE(stream));
    expect(events).toEqual([{ data: "one", id: "2" }]);
  });

  it("preserves bare \\r as a line separator inside a chunk", async () => {
    const stream = toStream(["data: a\rdata: b\n\n"]);
    const events = await collect(parseSSE(stream));
    expect(events).toEqual([{ data: "a\nb" }]);
  });
});

// ==========================
// parseNDJSON
// ==========================

describe("parseNDJSON", () => {
  it("parses single JSON line", async () => {
    const stream = toStream(['{"a":1}\n']);
    const results = await collect(parseNDJSON(stream));

    expect(results).toEqual([{ a: 1 }]);
  });

  it("parses multiple lines", async () => {
    const stream = toStream(['{"a":1}\n{"b":2}\n{"c":3}\n']);
    const results = await collect(parseNDJSON(stream));

    expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("skips empty lines", async () => {
    const stream = toStream(['{"a":1}\n\n\n{"b":2}\n']);
    const results = await collect(parseNDJSON(stream));

    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips malformed JSON without throwing", async () => {
    const spy = spyOn(console, "warn").mockImplementation(() => {});
    const stream = toStream(['{"a":1}\nnot-json\n{"b":2}\n']);
    const results = await collect(parseNDJSON(stream));

    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("handles objects split across chunks", async () => {
    const stream = toStream(['{"ke', 'y":"val', 'ue"}\n']);
    const results = await collect(parseNDJSON(stream));

    expect(results).toEqual([{ key: "value" }]);
  });

  it("handles different JSON types (objects, arrays, strings, numbers)", async () => {
    const stream = toStream([
      '{"obj":true}\n[1,2,3]\n"hello"\n42\n',
    ]);
    const results = await collect(parseNDJSON(stream));

    expect(results).toEqual([{ obj: true }, [1, 2, 3], "hello", 42]);
  });

  it("handles final line without trailing newline", async () => {
    const stream = toStream(['{"last":true}']);
    const results = await collect(parseNDJSON(stream));

    expect(results).toEqual([{ last: true }]);
  });
});
