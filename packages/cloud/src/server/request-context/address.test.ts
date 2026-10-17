import { expect, test } from "bun:test";
import { addressPrefix, publicClientAddress } from "./address";

for (const address of [
  "10.0.0.1",
  "172.16.0.1",
  "172.31.255.255",
  "192.168.1.2",
  "127.0.0.1",
  "::1",
  "169.254.2.3",
  "fe80::1",
  "100.64.0.1",
  "100.127.255.255",
  "fc00::",
  "fd12:3456::1",
  "::ffff:10.0.0.1",
  "::ffff:a00:1",
  "192.0.2.1",
  "2001:db8::1",
  "224.0.0.1",
  "ff02::1",
  "unknown",
  "",
  "garbage",
  "8.8.8.8:80",
  "[2a01:4f8::1]:80",
  "[2a01:4f8::1]",
  "2a01:4f8::1%eth0",
  "x".repeat(65),
  null,
  undefined,
])
  test(`reject ${address}`, () => {
    expect(publicClientAddress(address)).toBeNull();
    if (typeof address === "string") expect(addressPrefix(address)).toBeNull();
  });
for (const [input, expected] of [
  [" 8.8.8.8 ", "8.8.8.8"],
  ["::ffff:8.8.8.8", "8.8.8.8"],
  ["::FFFF:808:808", "8.8.8.8"],
  ["2A01:04F8:0001:0002:0000:0000:0000:0001", "2a01:4f8:1:2::1"],
  ["2a01:4f8::", "2a01:4f8::"],
])
  test(`canonical ${input}`, () => expect(publicClientAddress(input)).toBe(expected!));
test("network prefixes", () => {
  expect(addressPrefix("8.8.8.8")).toBe("8.8.8.8");
  expect(addressPrefix("::ffff:8.8.8.8")).toBe("8.8.8.8");
  expect(addressPrefix("2A01:04F8:1:2:abcd:ef01:2345:6789")).toBe("2a01:4f8:1:2::/64");
  expect(addressPrefix("2a01:4f8::1")).toBe("2a01:4f8::/64");
  expect(addressPrefix("2000::1")).toBe("2000::/64");
});
