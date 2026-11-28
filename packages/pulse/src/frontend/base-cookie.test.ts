import { expect, test } from "bun:test";
import { Hono } from "hono";
import { PULSE_BASE_COOKIE, rememberBase, rememberedBase } from "./base-cookie";

const app = new Hono()
  .get("/app/pulse/:baseId", (c) => {
    rememberBase(c, c.req.param("baseId"));
    return c.text("ok");
  })
  .get("/app/pulse", (c) => c.text(String(rememberedBase(c))));

test("a base page remembers its base for Pulse's pages only, for a year, out of reach of scripts", async () => {
  const secure = (await app.request("https://cloud.example.test/app/pulse/Ab12Cd")).headers.get("set-cookie");
  expect(secure).toBe(`${PULSE_BASE_COOKIE}=Ab12Cd; Max-Age=31536000; Path=/app/pulse; HttpOnly; Secure; SameSite=Lax`);
  // a plain-http development Cloud keeps it without Secure, unless its proxy says the page came over https
  expect((await app.request("http://localhost:3000/app/pulse/Ab12Cd")).headers.get("set-cookie")).not.toContain("Secure");
  const proxied = await app.request("http://pulse:3000/app/pulse/Ab12Cd", { headers: { "x-forwarded-proto": "https" } });
  expect(proxied.headers.get("set-cookie")).toContain("Secure");
});

test("only a public base id counts as the remembered base", async () => {
  const read = async (value: string) =>
    (await app.request("https://cloud.example.test/app/pulse", { headers: { cookie: `${PULSE_BASE_COOKIE}=${value}` } })).text();
  expect(await read("Ab12Cd")).toBe("Ab12Cd");
  for (const value of ["../admin", "Ab12Cd7", "", "%2F%2Fevil.example"]) expect(await read(value)).toBe("null");
  expect(await (await app.request("https://cloud.example.test/app/pulse")).text()).toBe("null");
});
