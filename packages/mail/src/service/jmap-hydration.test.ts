import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { JmapError } from "./connectors/jmap-client";
import { checkJmapHttp, JmapHttpError, JmapRateLimitError } from "./connectors/jmap-http";
import { JmapTransportError } from "./connectors/jmap-transport";
import { classifyJmapSourceFailure, interruptibleJmapSource } from "./jmap-hydration";
import { JMAP_HYDRATION_INTERRUPTED } from "./message-hydration";

// A fixed clock: no result depends on the day the test runs.
const now = Date.parse("2026-11-21T12:00:00Z");
const rateLimit = (retryAfter: string) => {
  try {
    checkJmapHttp({ status: 429, retryAfter, body: "" });
  } catch (error) {
    if (error instanceof JmapRateLimitError) return error;
  }
  throw new Error("expected a rate limit");
};
const codeOf = (error: unknown) => (error instanceof Error ? Reflect.get(error, "code") : undefined);

describe("a download that never reached the parser", () => {
  test("a missing source counts like a missing IMAP source", () => {
    expect(classifyJmapSourceFailure(new JmapTransportError("JMAP_SOURCE_MISSING"), now)).toEqual({ kind: "missing" });
  });

  test("a rate limit waits for its Retry-After", () => {
    expect(classifyJmapSourceFailure(rateLimit("30"), now)).toEqual({ kind: "rate_limited", retryAfterMs: 30_000 });
  });

  for (const [label, error] of [
    ["a refused login", new JmapHttpError(401)],
    ["a forbidden account", new JmapHttpError(403)],
    ["a server failure", new JmapHttpError(503)],
    ["a timeout", new JmapTransportError("JMAP_TIMEOUT")],
    ["a broken connection", new JmapTransportError("JMAP_TRANSPORT")],
    ["an abort", new JmapTransportError("JMAP_ABORTED")],
    ["a changed Session", new JmapError("JMAP_SESSION_CHANGED")],
    ["an error from outside the connector", new Error("database unavailable")],
  ] as const) {
    test(`${label} ends the batch without an attempt`, () => {
      expect(classifyJmapSourceFailure(error, now)).toEqual({ kind: "stop" });
    });
  }
});

describe("the source the parser reads", () => {
  test("passes the bytes through unchanged", async () => {
    const source = new PassThrough();
    const guarded = interruptibleJmapSource(source, new AbortController().signal);
    const chunks: Buffer[] = [];
    guarded.source.on("data", (chunk: Buffer) => chunks.push(chunk));
    source.end(Buffer.from([0, 1, 254, 255]));
    await once(guarded.source, "end");
    guarded.close();
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 1, 254, 255]));
    expect(guarded.signal.aborted).toBe(false);
  });

  test("a stream failure while the download runs on keeps its own error, so it counts an attempt", async () => {
    const source = new PassThrough();
    const guarded = interruptibleJmapSource(source, new AbortController().signal);
    const failed = once(guarded.source, "error");
    source.destroy(new JmapTransportError("JMAP_TRANSPORT"));
    const [error] = await failed;
    expect(codeOf(error)).toBe("JMAP_TRANSPORT");
    expect(guarded.signal.aborted).toBe(false);
  });

  test("a stopped lease or job turns the stream failure and the parser's cancellation into an interruption", async () => {
    const source = new PassThrough();
    const turn = new AbortController();
    const guarded = interruptibleJmapSource(source, turn.signal);
    const failed = once(guarded.source, "error");
    turn.abort(new Error("lease lost"));
    // The transport destroys its source with its own abort error.
    source.destroy(new JmapTransportError("JMAP_ABORTED"));
    const [error] = await failed;
    expect(codeOf(error)).toBe(JMAP_HYDRATION_INTERRUPTED);
    expect(codeOf(guarded.signal.reason)).toBe(JMAP_HYDRATION_INTERRUPTED);
  });

  test("an early stream failure before the parser listens is not unhandled", async () => {
    const source = new PassThrough();
    const guarded = interruptibleJmapSource(source, new AbortController().signal);
    // `once` would reject on the error event itself; only the close matters here.
    const closed = new Promise((resolve) => guarded.source.once("close", resolve));
    source.destroy(new JmapTransportError("JMAP_TRANSPORT"));
    await closed;
    expect(guarded.source.destroyed).toBe(true);
    expect(codeOf(guarded.source.errored)).toBe("JMAP_TRANSPORT");
  });
});
