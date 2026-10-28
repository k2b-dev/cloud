import { afterEach, expect, spyOn, test } from "bun:test";
import { createItemEventsApi } from "./item-events-api";

let request: ReturnType<typeof spyOn> | undefined;
afterEach(() => request?.mockRestore());
test("the typed client forwards selection, bounds, cursor and cancellation", async () => {
  const controller = new AbortController();
  let url = "",
    signal: AbortSignal | null | undefined;
  const original = globalThis.fetch;
  request = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        url = String(input);
        signal = init?.signal;
        return Response.json({ items: [], nextCursor: null, unavailable: true });
      },
      { preconnect: original.preconnect },
    ),
  );
  const page = await createItemEventsApi().list(
    "Cht001",
    { thread: "all", after: "2026-10-23T00:00:00Z", before: "2026-10-24T00:00:00Z", cursor: "owner-cursor", limit: 100 },
    controller.signal,
  );
  const parsed = new URL(url, "https://cloud.example.test");
  expect(parsed.pathname).toBe("/api/chat/conversations/Cht001/events");
  expect(Object.fromEntries(parsed.searchParams)).toEqual({
    thread: "all",
    after: "2026-10-23T00:00:00Z",
    before: "2026-10-24T00:00:00Z",
    cursor: "owner-cursor",
    limit: "100",
  });
  expect(signal).toBe(controller.signal);
  expect(page).toEqual({ items: [], nextCursor: null, unavailable: true });
});
