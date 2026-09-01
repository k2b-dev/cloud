import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { session } from "./index";

const probe = new Hono().get("/", (c) => c.json({ token: session.getToken(c) }));

describe("session credential precedence", () => {
  test("an explicit non-API bearer wins over the browser cookie", async () => {
    const response = await probe.request("/", {
      headers: { authorization: "Bearer explicit-token", cookie: "session_token=cookie-token" },
    });
    expect(await response.json()).toEqual({ token: "explicit-token" });
  });

  test("Cloud API credentials stay available to the API-key authenticator", async () => {
    const response = await probe.request("/", {
      headers: { authorization: "Bearer cld_prefix_secret", cookie: "session_token=cookie-token" },
    });
    expect(await response.json()).toEqual({ token: null });
  });

  test("uses the host-only browser cookie without a bearer", async () => {
    const response = await probe.request("/", { headers: { cookie: "session_token=cookie-token" } });
    expect(await response.json()).toEqual({ token: "cookie-token" });
  });
});
