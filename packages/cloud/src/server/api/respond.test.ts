import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { respond } from "./respond";

describe("respond", () => {
  test("supports bounded transport and upstream failure statuses", async () => {
    for (const status of [413, 422, 502, 503, 504] as const) {
      const app = new Hono().get("/", (c) => respond(c, { ok: false, error: "PDF failed", status }));
      const response = await app.request("/");

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ message: "PDF failed" });
    }
  });

  test("preserves explicit recovery details and authoritative error message/code", async () => {
    const receipt = { cursor: "42", update: "original-bytes" };
    const app = new Hono().get("/", (c) =>
      respond(
        c,
        { ok: false, error: "Published but not saved", status: 500, code: "table_action_persist_failed" },
        { errorDetails: { accepted: true, cursor: "42", receipt, message: "wrong", code: "wrong" } },
      ),
    );
    const response = await app.request("/");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      message: "Published but not saved",
      code: "table_action_persist_failed",
      accepted: true,
      cursor: "42",
      receipt,
    });
  });

  test("does not introduce a code from recovery details when the error has none", async () => {
    const app = new Hono().get("/", (c) =>
      respond(c, { ok: false, error: "Too large", status: 413 }, { errorDetails: { accepted: false, code: "wrong", message: "wrong" } }),
    );
    const response = await app.request("/");
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ message: "Too large", accepted: false });
  });
});
