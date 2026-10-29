import { expect, test } from "bun:test";
import { Hono } from "hono";
import { shareAccessContext } from "./share-access-context";

const app = new Hono().get("/", (c) => c.json(shareAccessContext(c)));

test.each([
  [{}, { network: "unknown", client: "other" }],
  [
    { "x-forwarded-for": " 192.0.2.231 , 198.51.100.19", "x-real-ip": "203.0.113.9", "user-agent": "Firefox/123 secret-ua" },
    { network: "192.0.2.0/24", client: "firefox" },
  ],
  [
    { "x-real-ip": "::ffff:192.0.2.231", "user-agent": "Chrome/123" },
    { network: "192.0.2.0/24", client: "chrome" },
  ],
  [
    { "x-forwarded-for": "2001:db8:abcd:1234::9", "user-agent": "Chrome/123 Edg/123" },
    { network: "2001:db8:abcd::/48", client: "edge" },
  ],
  [
    { "x-forwarded-for": "", "x-real-ip": "192.0.2.1" },
    { network: "unknown", client: "other" },
  ],
  [
    { "x-forwarded-for": "malformed", "x-real-ip": "192.0.2.1" },
    { network: "unknown", client: "other" },
  ],
  [{ "user-agent": "unrecognized custom client secret" }, { network: "unknown", client: "other" }],
  [
    { "sec-ch-ua": '"Microsoft Edge";v="123", "Chromium";v="123"', "user-agent": "Chrome/123" },
    { network: "unknown", client: "edge" },
  ],
  [
    { "x-real-ip": "x".repeat(1000), "user-agent": "x".repeat(1000) },
    { network: "unknown", client: "other" },
  ],
] satisfies [Record<string, string>, { network: string; client: string }][])(
  "request context keeps only the masked network and browser enum (%#)",
  async (headers, expected) => {
    const response = await app.request("/", { headers });
    expect(await response.json()).toEqual(expected);
  },
);
