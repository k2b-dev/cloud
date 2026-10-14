import { expect, test } from "bun:test";
import type { WidgetStreamLine } from "../contracts/widgets";
import { streamWidgets } from "./widgets";

test("the browser sends entry settings with POST and retains GET keys and sizes", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response('{"type":"start","widgets":[]}\n{"type":"done","status":"complete"}\n', {
        headers: { "content-type": "application/x-ndjson" },
      });
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const lines: WidgetStreamLine[] = [];
    const signal = new AbortController().signal;
    const options = { signal, locale: "de-CH", onLine: (line: WidgetStreamLine) => lines.push(line) };
    const requests = [
      { id: "entry", key: "spaces/today", size: "large", settings: { space: { type: "spaces.space", id: "abc123" } } },
    ] as const;
    await streamWidgets({ ...options, keys: ["ignored/key"], sizes: { "ignored/key": "small" }, requests });
    expect(calls[0]?.url).toBe("/api/widgets/v1");
    expect(calls[0]?.init).toEqual({
      method: "POST",
      body: JSON.stringify({ widgets: requests }),
      signal,
      headers: { accept: "application/x-ndjson", "x-cloud-locale": "de-CH", "content-type": "application/json" },
    });
    await streamWidgets({ ...options, keys: ["spaces/today"], sizes: { "spaces/today": "medium" } });
    expect(calls[1]?.url).toBe("/api/widgets/v1?widget=spaces%2Ftoday%40medium");
    expect(calls[1]?.init).toEqual({ signal, headers: { accept: "application/x-ndjson", "x-cloud-locale": "de-CH" } });
    expect(lines).toHaveLength(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
