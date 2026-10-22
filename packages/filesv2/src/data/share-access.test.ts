import { expect, test } from "bun:test";
import { maintainShareAccess, maskShareAccessNetwork, SHARE_ACCESS_CLIENTS } from "./share-access";

test.each([
  ["192.0.2.231", "192.0.2.0/24"],
  [" 192.0.2.231 ", "192.0.2.0/24"],
  ["192.0.2.0/24", "192.0.2.0/24"],
  ["::ffff:192.0.2.231", "192.0.2.0/24"],
  ["0:0:0:0:0:FFFF:C000:02E7", "192.0.2.0/24"],
  ["::ffff:c000:2e7", "192.0.2.0/24"],
  ["2001:0DB8:ABCD:1234:5678:9abc:def0:1234", "2001:db8:abcd::/48"],
  ["2001:db8:abcd::1", "2001:db8:abcd::/48"],
  ["2001:db8:abcd::/48", "2001:db8:abcd::/48"],
  ["::1", "::/48"],
  ["2001:0:0:1::1", "2001::/48"],
  ["::192.0.2.231", "::/48"],
  ["255.255.255.255", "255.255.255.0/24"],
  ["::ffff:255.255.255.255", "255.255.255.0/24"],
])("masks and canonicalizes %s", (address, expected) => {
  expect(maskShareAccessNetwork(address)).toBe(expected);
  expect(maskShareAccessNetwork(expected)).toBe(expected);
});

test.each([
  undefined,
  "",
  "unknown",
  "*",
  "192.0.2.256",
  "192.00.2.1",
  "192.0.2.1:443",
  "192.0.2.1, 198.51.100.1",
  "192.0.2.1/32",
  "192.0.2.1/48",
  "192.0.2.0/24/24",
  "[2001:db8::1]",
  "fe80::1%eth0",
  "2001:db8::1::2",
  "2001:db8::1/64",
  "2001:db8::1/24",
  "x".repeat(100_000),
  " ".repeat(100_000) + "192.0.2.1",
  "<script>alert(1)</script>",
])("invalid or oversized addresses become unknown (%#)", (address) => {
  expect(maskShareAccessNetwork(address)).toBe("unknown");
});

test("stored clients are a fixed short enum", () => {
  expect(SHARE_ACCESS_CLIENTS).toEqual(["firefox", "chrome", "safari", "edge", "samsung", "opera", "other", "unknown"]);
  expect(SHARE_ACCESS_CLIENTS.every((client) => client.length <= 16)).toBe(true);
});

test.each([0, 29, 3651, 30.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "invalid retention is refused before querying (%#)",
  async (retentionDays) => {
    await expect(maintainShareAccess({ now: new Date("2030-05-15T12:34:56Z"), retentionDays })).rejects.toThrow(RangeError);
  },
);
