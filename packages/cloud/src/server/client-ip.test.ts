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

import { clientIpBucket } from "./client-ip";

test.each([
  ["192.0.2.1", "ip:192.0.2.1"],
  ["2001:db8:1:2::1", "ip6:2001:db8:1:2::/64"],
  ["2001:0DB8:0001:0002:0000:0000:0000:0001", "ip6:2001:db8:1:2::/64"],
  ["2001:db8:1:2:ffff::9", "ip6:2001:db8:1:2::/64"],
  ["2001:db8:1:3::1", "ip6:2001:db8:1:3::/64"],
  ["2001:db8::1", "ip6:2001:db8:0:0::/64"],
  ["::", "ip6:0:0:0:0::/64"],
  ["::1", "ip6:0:0:0:0::/64"],
  ["fe80::1%eth0", "ip6:fe80:0:0:0::/64"],
  ["2001:db8:1:2::192.0.2.1", "ip6:2001:db8:1:2::/64"],
  ["::ffff:192.0.2.1", "ip:192.0.2.1"],
  ["::ffff:c000:201", "ip:192.0.2.1"],
  ["0000:0000:0000:0000:0000:FFFF:C000:0201", "ip:192.0.2.1"],
  ["::ffff:0:192.0.2.1", "ip6:0:0:0:0::/64"],
  ["64:ff9b::192.0.2.1", "ip:192.0.2.1"],
  ["64:ff9b::c633:6402", "ip:198.51.100.2"],
  ["2001:0:4136:e378:8000:63bf:3fff:fdd2", "ip:192.0.2.45"],
  ["2001:0:4136:e378:8000:1111:3fff:fdd2", "ip:192.0.2.45"],
  ["2001:0:4136:e378:8000:63bf:3fff:fdd3", "ip:192.0.2.44"],
  ["2002:c000:201:1::1", "ip:192.0.2.1"],
  ["2002:c000:201:ffff::9", "ip:192.0.2.1"],
  ["2002:c633:6402::1", "ip:198.51.100.2"],
  ["unknown", "ip:unknown"],
  ["garbage", "ip:garbage"],
  ["2001:db8:::1", "ip:2001:db8:::1"],
  ["", "ip:"],
])("client address %s uses bucket %s", (ip, bucket) => {
  expect(clientIpBucket(ip)).toBe(bucket);
});
