import { describe, expect, setSystemTime, test } from "bun:test";
import { Hono } from "hono";
import { env } from "../../config/env";
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

describe("web session cookie lifetime", () => {
  test("uses the family's remaining lifetime with the existing web cookie attributes", async () => {
    const now = new Date("2026-10-19T12:00:00Z");
    setSystemTime(now);
    try {
      const app = new Hono().get("/", (c) => {
        session.setWebCookie(c, "fixture", new Date(now.getTime() + 125_900));
        return c.body(null, 204);
      });
      const cookie = (await app.request("/")).headers.get("set-cookie");
      expect(cookie).toContain("Max-Age=125");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      expect(cookie?.includes("Secure")).toBe(!env.IS_DEVELOPMENT);
    } finally {
      setSystemTime();
    }
  });

  test("never extends a session that already expired", async () => {
    const now = new Date("2026-10-19T12:00:00Z");
    setSystemTime(now);
    try {
      const app = new Hono().get("/", (c) => {
        session.setWebCookie(c, "fixture", new Date(now.getTime() - 1_000));
        return c.body(null, 204);
      });
      expect((await app.request("/")).headers.get("set-cookie")).toContain("Max-Age=0");
    } finally {
      setSystemTime();
    }
  });
});
