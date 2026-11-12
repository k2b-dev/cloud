import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { hkdfSync } from "node:crypto";
import { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { bindProcessApplicationId, clearProcessApplicationId } from "../_internal/process-identity";
import { connectionFixture, stubConnections } from "../runtime/connections.test-fixture";
import { appKey, appKeys } from "./app-key";

const connection = stubConnections();
beforeEach(() => connection.mockReturnValue(connectionFixture()));
afterEach(() => clearProcessApplicationId());
afterAll(() => connection.mockRestore());

// The secret snapshot is fixed; these tests never initialize clients.
test("appKey derives exactly 32 HKDF-SHA-256 bytes and separates app and purpose", () => {
  bindProcessApplicationId("inventory", [], "same-package");
  const key = appKey("customer-session");
  expect(typeof key).toBe("string");
  expect(Buffer.from(key, "base64url").byteLength).toBe(32);
  expect(key).toEqual(
    Buffer.from(hkdfSync("sha256", "test-only-platform-secret", "inventory", "customer-session", 32)).toString("base64url"),
  );
  expect(appKey("customer-session")).toEqual(key);
  expect(appKey("invitation")).not.toEqual(key);
  clearProcessApplicationId();
  bindProcessApplicationId("another-app", [], "same-package");
  expect(appKey("customer-session")).not.toEqual(
    Buffer.from(hkdfSync("sha256", "test-only-platform-secret", "inventory", "customer-session", 32)).toString("base64url"),
  );
});

test("appKey requires startup, a secret, and a valid purpose", () => {
  expect(() => appKey("session")).toThrow("Start the application");
  bindProcessApplicationId("inventory");
  for (const name of ["", "Session", "a_b", "a/b", "a".repeat(65)]) expect(() => appKey(name)).toThrow("Purpose name");
  connection.mockReturnValue(connectionFixture({ appSecret: { current: " " } }));
  expect(() => appKey("session")).toThrow("APP_SECRET");
});

test("appKey passes directly to Hono signed cookies; secret rotation rejects old signatures", async () => {
  bindProcessApplicationId("inventory");
  const app = new Hono();
  app.get("/issue", async (c) => {
    await setSignedCookie(c, "__Host-customer", "session-id", appKey("session"), {
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
    });
    return c.text("issued");
  });
  app.get("/read", async (c) => c.json({ value: await getSignedCookie(c, appKey("session"), "__Host-customer") }));
  const response = await app.request("https://example.test/issue");
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  expect(cookie).toBeDefined();
  const headers = { cookie: cookie ?? "" };
  expect(await (await app.request("https://example.test/read", { headers })).json()).toEqual({ value: "session-id" });
  connection.mockReturnValue(connectionFixture({ appSecret: { current: "rotated-secret" } }));
  expect(await (await app.request("https://example.test/read", { headers })).json()).toEqual({ value: false });
});

test("purpose keys sign with current and verify with previous or next without changing the HKDF vector", async () => {
  bindProcessApplicationId("inventory");
  const A = "ab".repeat(32),
    B = "cd".repeat(32);
  connection.mockReturnValue(connectionFixture({ appSecret: { current: A } }));
  const keyA = appKey("session");
  const issued = new Hono().get("/", async (c) => {
    await setSignedCookie(c, "site", "visitor", keyA);
    return c.text("ok");
  });
  const cookie = (await issued.request("https://example.test/")).headers.get("set-cookie")!.split(";")[0]!;
  connection.mockReturnValue(connectionFixture({ appSecret: { current: B, previous: A } }));
  const keyB = appKey("session");
  expect(appKeys("session")).toEqual([keyB, keyA]);
  const read = new Hono().get("/", async (c) => {
    for (const key of appKeys("session")) {
      const value = await getSignedCookie(c, key, "site");
      if (value) return c.text(value);
    }
    return c.text("invalid");
  });
  expect(await (await read.request("https://example.test/", { headers: { cookie } })).text()).toBe("visitor");
  connection.mockReturnValue(connectionFixture({ appSecret: { current: A, next: B } }));
  expect(appKeys("session")).toEqual([keyA, keyB]);
  connection.mockReturnValue(connectionFixture({ appSecret: { current: B } }));
  expect(await (await read.request("https://example.test/", { headers: { cookie } })).text()).toBe("invalid");
});
