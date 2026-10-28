import { afterEach, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { createNestedCapabilityQuery } from "./nested";

const originalFetch = globalThis.fetch;
const previousOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;
let fetching: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => {
  fetching?.mockRestore();
  if (previousOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = previousOrigin;
});

test("handler Query goes only through Core with its incoming invocation, metadata and cancellation", async () => {
  process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.test";
  const controller = new AbortController();
  let forwarded: Request | undefined;
  fetching = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        forwarded = new Request(input, init);
        expect(forwarded.url).toBe("http://core.test/api/_internal/identity/v1/invoke-child");
        expect(forwarded.headers.get("authorization")).toBe("Bearer parent-invocation");
        expect(forwarded.headers.get("cookie")).toBeNull();
        expect(forwarded.headers.get("x-cloud-locale")).toBe("de");
        expect(await forwarded.json()).toEqual({ targetApp: "spaces", capabilityId: "item.read", input: { id: "one" } });
        return Response.json({ data: { id: "one", additive: true } });
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const query = createNestedCapabilityQuery(
    new Request("http://chat.test/capability", {
      headers: { authorization: "Bearer parent-invocation", cookie: "session=never-forward", "x-cloud-locale": "de" },
      signal: controller.signal,
    }),
  );
  expect(await query({ appId: "spaces", capabilityId: "item.read", input: { id: "one" } }, z.object({ id: z.string() }))).toEqual({
    ok: true,
    data: { data: { id: "one" } },
  });
  controller.abort();
  expect(forwarded?.signal.aborted).toBe(true);
});

test("without the configured private Core origin the helper sends no credential", async () => {
  delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  fetching = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        throw new Error("No public fallback");
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const result = await createNestedCapabilityQuery(new Request("http://chat.test", { headers: { authorization: "Bearer parent" } }))(
    { appId: "spaces", capabilityId: "item.read", input: {} },
    z.unknown(),
  );
  expect(result.ok).toBe(false);
  expect(fetching).not.toHaveBeenCalled();
});
