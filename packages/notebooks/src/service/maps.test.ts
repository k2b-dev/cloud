import { afterEach, expect, test } from "bun:test";
import { notebookMapState } from "./maps";

const originalOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
afterEach(() => {
  if (originalOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalOrigin;
});
const availability = {
  configured: false,
  cloud: { exhausted: false, resetsAt: "2026-11-01T00:00:00Z" },
  person: { exhausted: false, resetsAt: "2026-10-23T00:00:00Z" },
};

test("map availability forwards the reading caller, request locale and cancellation only to Core", async () => {
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.example.test";
  const controller = new AbortController();
  const result = await notebookMapState(
    ":::map\n{}\n:::",
    {
      cookie: "session=fictional",
      authorization: "Bearer fictional",
      locale: "de-CH",
      signal: controller.signal,
      transport: async (request) => {
        expect(request.url).toBe("https://core.example.test/api/capabilities/v1/queries/core/geo.availability");
        expect(request.headers.get("cookie")).toBe("session=fictional");
        expect(request.headers.get("authorization")).toBe("Bearer fictional");
        expect(request.headers.get("x-cloud-locale")).toBe("de-CH");
        controller.abort();
        expect(request.signal.aborted).toBe(true);
        return Response.json({ data: availability });
      },
    },
    true,
  );
  expect(result).toEqual({ availability, canAdmin: true });
});

test("plain notes do not invoke Geo, while failures remain visible and recoverable", async () => {
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.example.test";
  let calls = 0;
  const caller = {
    transport: async () => {
      calls++;
      return new Response(null, { status: 503 });
    },
  };
  expect(await notebookMapState("# Ordinary note", caller)).toBeUndefined();
  expect(calls).toBe(0);
  expect(await notebookMapState(":::map\n{}\n:::", caller)).toEqual({ failed: true, canAdmin: false });
  expect(calls).toBe(1);
});
