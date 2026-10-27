import { afterEach, expect, test } from "bun:test";
import { ChatRequestError } from "./chat-store";
import { createSearchApi } from "./search-api";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const respondWith = (run: (request: Request) => Response | Promise<Response>) => {
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const value = typeof input === "string" && input.startsWith("/") ? `https://cloud.example.test${input}` : input;
      return run(new Request(value, init));
    },
    { preconnect: originalFetch.preconnect },
  );
};

test("typed search trims and encodes the query, accepts partial results and forwards cancellation", async () => {
  const controller = new AbortController();
  respondWith((request) => {
    expect(new URL(request.url).pathname).toBe("/api/chat/search");
    expect(new URL(request.url).searchParams.get("q")).toBe("IT & tools");
    controller.abort();
    expect(request.signal.aborted).toBe(true);
    return Response.json({ items: [], systemUnavailable: true });
  });
  expect(await createSearchApi().search("  IT & tools  ", controller.signal)).toEqual({ items: [], systemUnavailable: true });
});

test("request errors retain the server's localized message, status and stable code", async () => {
  respondWith(() => Response.json({ message: "Ungültige Suche", code: "BAD_INPUT" }, { status: 400 }));
  try {
    await createSearchApi().search("IT");
    throw new Error("Expected request failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ChatRequestError);
    expect(error).toMatchObject({ message: "Ungültige Suche", code: "BAD_INPUT", status: 400 });
  }
});

test("invalid queries never send requests and malformed success bodies reject", async () => {
  let calls = 0;
  respondWith(() => {
    calls++;
    return Response.json({ items: [], systemUnavailable: false });
  });
  await expect(createSearchApi().search(" ")).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(createSearchApi().search("IT")).rejects.toThrow();
  expect(calls).toBe(1);
});
