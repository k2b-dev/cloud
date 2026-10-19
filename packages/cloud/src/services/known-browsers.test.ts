import { expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { browserHash, newBrowserCookie, readBrowserCookie, setBrowserCookie } from "./known-browsers";

const userId = "00112233-4455-6677-8899-aabbccddeeff";
const cookie = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq";

test("browser hash is raw SHA-256 of canonical user id followed by cookie text", () => {
  const hash = browserHash(userId, cookie);
  expect(hash.byteLength).toBe(32);
  // Independently computed from the literal concatenation, without delimiters or decoded cookie bytes.
  expect(hash.toString("hex")).toBe("0c21161095cc3bd3a0a69011dfca3d983e4deb5567930c298ab0c420e66bceeb");
  expect(browserHash(cookie, userId).equals(hash)).toBe(false);
  expect(browserHash(userId.toUpperCase(), cookie).equals(hash)).toBe(true);
});

test("browser cookie reads accept exactly 43 base64url characters", async () => {
  const app = new Hono().get("/", (c) => c.json({ value: readBrowserCookie(c, false) }));
  for (const value of [
    undefined,
    "",
    "a".repeat(42),
    "a".repeat(44),
    `${"a".repeat(42)}=`,
    `${"a".repeat(42)}+`,
    `${"a".repeat(42)}/`,
    `${"a".repeat(43)}%0A`,
  ]) {
    const response = await app.request("/", { headers: value === undefined ? {} : { cookie: `__Host-cloud_browser=${value}` } });
    expect(await response.json()).toEqual({ value: null });
  }
  for (const value of [cookie, `${"a".repeat(41)}_-`]) {
    expect(await (await app.request("/", { headers: { cookie: `__Host-cloud_browser=${value}` } })).json()).toEqual({ value });
  }
  expect(newBrowserCookie()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const random = new Uint8Array(32).fill(255);
  // The random source receives 32 bytes; encoding has no padding.
  const getRandomValues = spyOn(crypto, "getRandomValues").mockImplementation((target: Uint8Array) => {
    if (!(target instanceof Uint8Array) || target.length !== 32) throw new Error("Expected 32 random bytes");
    target.set(random);
    return target;
  });
  try {
    expect(newBrowserCookie()).toBe(Buffer.from(random).toString("base64url"));
  } finally {
    getRandomValues.mockRestore();
  }
});

for (const development of [false, true]) {
  test(`browser cookie attributes (${development ? "development" : "production"})`, async () => {
    const app = new Hono().get("/", (c) => {
      setBrowserCookie(c, cookie, development);
      return c.text("ok");
    });
    const response = await app.request("/");
    const parts = response.headers.get("set-cookie")!.split("; ");
    expect(parts.shift()).toBe(`${development ? "cloud_browser" : "__Host-cloud_browser"}=${cookie}`);
    expect(parts.sort()).toEqual(["HttpOnly", "Max-Age=7776000", "Path=/", "SameSite=Strict", ...(!development ? ["Secure"] : [])].sort());
    const reader = new Hono().get("/", (c) => c.json({ value: readBrowserCookie(c, development) }));
    expect(
      await (
        await reader.request("/", { headers: { cookie: `${development ? "cloud_browser" : "__Host-cloud_browser"}=${cookie}` } })
      ).json(),
    ).toEqual({ value: cookie });
  });
}
