import { beforeEach, expect, mock, test } from "bun:test";
import type { z } from "zod";
import { CalendarDestinationListDataSchema } from "../../../spaces/src/capability-contracts";

const calls: Array<{ input: unknown; request: unknown }> = [];
let responses: Array<{ data: unknown; page?: { hasMore: boolean; nextCursor?: string } }> = [];
mock.module("@k2b/cloud/capabilities/server", () => ({
  getCapabilityCatalogApp: async () => ({ ok: false }),
  invokeCapabilityWithDataSchema: async (call: { input: unknown }, schema: z.ZodType, request: unknown) => {
    calls.push({ input: call.input, request });
    const response = responses.shift();
    if (!response) return { ok: false, error: { code: "APP_UNAVAILABLE", message: "Unavailable", status: 503 } };
    return { ok: true, data: { ...response, data: schema.parse(response.data) } };
  },
}));
const { listCalendarDestinations } = await import("./app-integrations");
const destination = (id: string) => ({ id, name: id, color: "#3b82f6" });
beforeEach(() => {
  calls.length = 0;
  responses = [];
});

test("follows current Spaces destination pages without losing the Mail picker contract", async () => {
  responses = [
    {
      data: CalendarDestinationListDataSchema.parse([{ ...destination("space1"), ref: { type: "spaces.space", id: "space1" } }]),
      page: { hasMore: true, nextCursor: "page2" },
    },
    {
      data: CalendarDestinationListDataSchema.parse([{ ...destination("space2"), ref: { type: "spaces.space", id: "space2" } }]),
      page: { hasMore: false },
    },
  ];
  const request = { authorization: "test-authorization", signal: new AbortController().signal };
  expect(await listCalendarDestinations(request)).toMatchObject({ ok: true, data: [destination("space1"), destination("space2")] });
  expect(calls).toEqual([
    { input: { limit: 100 }, request },
    { input: { limit: 100, cursor: "page2" }, request },
  ]);
});

test("accepts an unpaged producer and does not hide later-page failures", async () => {
  responses = [{ data: [destination("space1")] }];
  expect((await listCalendarDestinations({})).ok).toBeTrue();
  responses = [{ data: [destination("space1")], page: { hasMore: true, nextCursor: "page2" } }];
  expect(await listCalendarDestinations({})).toMatchObject({ ok: false, status: 503 });
});

test("rejects invalid continuation and bounded overflow instead of returning a partial picker", async () => {
  responses = [{ data: [], page: { hasMore: true } }];
  expect(await listCalendarDestinations({})).toMatchObject({ ok: false, code: "INVALID_APP_RESPONSE" });
  responses = Array.from({ length: 2 }, () => ({ data: [], page: { hasMore: true, nextCursor: "same" } }));
  expect(await listCalendarDestinations({})).toMatchObject({ ok: false, code: "INVALID_APP_RESPONSE" });
  responses = [{ data: [], page: { hasMore: true, nextCursor: "empty" } }];
  expect(await listCalendarDestinations({})).toMatchObject({ ok: false, code: "INVALID_APP_RESPONSE" });
});

test("follows short byte-limited pages rather than assuming five full pages", async () => {
  const items = Array.from({ length: 6 }, (_, index) => destination(String(index).padStart(6, "0")));
  responses = items.map((item, index) => ({ data: [item], page: { hasMore: index < 5, nextCursor: String(index + 1) } }));
  expect(await listCalendarDestinations({})).toEqual({ ok: true, data: items });
});

test("preserves all 500 supported picker entries and rejects a larger result", async () => {
  const items = Array.from({ length: 500 }, (_, index) => destination(String(index).padStart(6, "0")));
  responses = Array.from({ length: 5 }, (_, index) => ({
    data: items.slice(index * 100, (index + 1) * 100),
    page: { hasMore: index < 4, ...(index < 4 ? { nextCursor: `page${index + 1}` } : {}) },
  }));
  expect(await listCalendarDestinations({})).toEqual({ ok: true, data: items });
  responses = [{ data: items, page: { hasMore: true, nextCursor: "overflow" } }, { data: [destination("extra1")] }];
  expect(await listCalendarDestinations({})).toMatchObject({ ok: false, code: "RESULT_TOO_LARGE" });
});
