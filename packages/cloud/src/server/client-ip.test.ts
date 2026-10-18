import { expect, test } from "bun:test";
import { Hono } from "hono";
import { clientIp } from "./client-ip";

test("preserves rate limiter forwarding precedence and empty header behavior", async () => {
  const app = new Hono().get("/", (c) => c.text(clientIp(c)));
  for (const [headers, expected] of [
    [{ "x-forwarded-for": " 8.8.8.8 , 1.1.1.1", "x-real-ip": "9.9.9.9" }, "8.8.8.8"],
    [{ "x-real-ip": "9.9.9.9" }, "9.9.9.9"],
    [{ "x-forwarded-for": "", "x-real-ip": "9.9.9.9" }, ""],
    [{}, "unknown"],
  ] satisfies [Record<string, string>, string][])
    expect(await (await app.request("/", { headers })).text()).toBe(expected);
});
