import { afterEach, expect, spyOn, test } from "bun:test";
import { StoreClientError, storeClient } from "./store-client";
let mock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => mock?.mockRestore());
test("store helpers use same-origin paths, credentials and typed sanitized check failures", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  mock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return Response.json(
          {
            code: "STORE_CHECK_FAILED",
            status: {
              ok: false,
              code: "AUTH_FAILED",
              checkedAt: "2026-10-17T12:00:00Z",
              steps: { reach: "ok", auth: "failed", version: "skipped", rights: "skipped", profiles: "skipped" },
            },
          },
          { status: 422 },
        );
      },
      { preconnect: fetch.preconnect },
    ),
  );
  try {
    await storeClient.save({ url: "http://fixture.invalid", user: "fixture", password: "obviously-fake-password" });
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(StoreClientError);
    expect(error).toMatchObject({ status: 422, code: "STORE_CHECK_FAILED", check: { code: "AUTH_FAILED" } });
    expect(String(error)).not.toContain("obviously-fake-password");
  }
  expect(calls[0]?.url).toBe("/api/pulse/admin/store");
  expect(calls[0]?.init?.credentials).toBe("same-origin");
});
