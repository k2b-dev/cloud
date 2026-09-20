import { expect, test } from "bun:test";
import { Hono } from "hono";
import { setShareAccessCookie, shareAccessCookie } from "./share-access-cookie";

test("share proof cookie is HttpOnly, secure in HTTPS and scoped to its share subtree", async () => {
  const app = new Hono().get("/", (c) => {
    setShareAccessCookie(c, "inbox", "token123", "opaque-proof");
    return c.text("ok");
  });
  const response = await app.request("https://cloud.example/");
  const cookie = response.headers.get("set-cookie")!;
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=43200", "Path=/share/filesv2/inbox/token123"])
    expect(cookie).toContain(attribute);
  expect(cookie).not.toContain("Domain=");
  const read = new Hono().get("/", (c) => c.text(shareAccessCookie(c) ?? ""));
  expect(await (await read.request("/", { headers: { cookie: cookie.split(";")[0]! } })).text()).toBe("opaque-proof");
});
