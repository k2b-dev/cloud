import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { respond } from "./respond";

describe("respond", () => {
  test("returns the accepted state for durable work", async () => {
    const app = new Hono().post("/", (c) => respond(c, { ok: true, data: { status: "writing" } }, 202));
    const response = await app.request("/", { method: "POST" });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "writing" });
  });
  test("supports bounded transport and upstream failure statuses", async () => {
    for (const status of [413, 422, 502, 503, 504] as const) {
      const app = new Hono().get("/", (c) => respond(c, { ok: false, error: "PDF failed", status }));
      const response = await app.request("/");

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ message: "PDF failed" });
    }
  });
});
