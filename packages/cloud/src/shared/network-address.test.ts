import { describe, expect, test } from "bun:test";
import {
  EMPTY_NETWORK_ALLOWLIST,
  isAllowlistedNetworkAddress,
  isUnsafeNetworkAddress,
  isUnsafeNetworkHostname,
  networkAddressFamily,
  parseNetworkAddress,
  parseNetworkAllowlist,
  parseNetworkAllowlistEnv,
} from "./network-address";

describe("network address policy", () => {
  test.each([
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "::ffff:7f00:1",
    "[::1]",
    "::",
    "0.0.0.0",
    "127.1",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "0x7f.1",
    "127.1.",
    "169.254.169.254",
    "fd00::1",
    "fe80::1%eth0",
    "::7f00:1",
    "::ffff:0:7f00:1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2001:0:4136:e378::1",
    "5f00::1",
    "ff02::1",
    "255.255.255.255",
    "198.18.0.1",
    "10.2.3.4",
    "100.64.0.1",
    "172.31.2.3",
    "192.168.1.1",
    "198.51.100.2",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "64:ff9b:1::1",
    "100::1",
    "2001::1",
    "2001:2::1",
    "2001:20::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "203.0.113.1",
    "240.0.0.1",
    "2001:1ff::1",
    "not-an-address",
    "1.2.3.4.5",
    "08",
    "4294967296",
    "1:2:3:4:5:6:7::8",
    "[::1",
    "::1]",
    "2000::1.",
    "[8.8.8.8]",
  ])("refuses %s", (address) => expect(isUnsafeNetworkAddress(address)).toBe(true));

  test.each(["1.1.1.1", "8.8.8.8", "64:ff9b::808:808", "::ffff:8.8.8.8", "2606:4700:4700::1111", "2001:4860:4860::8888", "0x08080808"])(
    "allows %s",
    (address) => expect(isUnsafeNetworkAddress(address)).toBe(false),
  );

  test.each([
    "localhost",
    "x.localhost",
    "localhost.localdomain",
    "metadata",
    "metadata.google.internal",
    "instance-data",
    "x.internal",
    "printer.local",
    "router.home.arpa",
    "",
    "1.2.3.4.5",
    "example.123",
    "example.0xff",
    "08",
  ])("refuses hostname %s", (host) => expect(isUnsafeNetworkHostname(host)).toBe(true));

  test("canonicalizes literals and agrees on their families", () => {
    for (const host of ["8.8.8.8", "0x08080808", "010.010.010.010", "8.526344", "8.8.2056", "134744072", "0X8.0x080808."]) {
      expect(parseNetworkAddress(host)).toEqual({ address: "8.8.8.8", family: 4 });
      expect(networkAddressFamily(host)).toBe(4);
    }
    expect(parseNetworkAddress("[::ffff:127.0.0.1]")).toEqual({ address: "::ffff:7f00:1", family: 6 });
    expect(networkAddressFamily("[::ffff:127.0.0.1]")).toBe(6);
    for (const host of ["example.com", "1.2.3.4.5", "fe80::1%eth0", "1:2:3:4:5:6:7::8", "[::1", "::1]"]) {
      expect(parseNetworkAddress(host)).toBeNull();
      expect(networkAddressFamily(host)).toBeNull();
    }
    expect(isUnsafeNetworkHostname("example.com")).toBe(false);
  });
});

describe("operator network allowlist", () => {
  test("normalizes exact host names and strict single IP entries", () => {
    const list = parseNetworkAllowlist(["Prometheus", "METRICS.Example.", "10.0.0.5", "[FD00::1]", "::ffff:10.0.0.5"]);
    expect([...list.hosts]).toEqual(["prometheus", "metrics.example"]);
    expect(list.networks).toEqual([
      { address: "10.0.0.5", family: 4, bits: 32 },
      { address: "fd00::1", family: 6, bits: 128 },
      { address: "::ffff:a00:5", family: 6, bits: 128 },
    ]);
  });

  test.each([
    "",
    "*.example",
    "http://example.com",
    "example.com:80",
    "example.com/path",
    "u@example.com",
    " example.com",
    "a_b",
    "-x.test",
    "x-.test",
    "x..test",
    "example..",
    "127.1",
    "0177.0.0.1",
    "0x7f000001",
    "2130706433",
    "256.0.0.1",
    "1.2.3.4.5",
    "example.123",
    "08",
    "[8.8.8.8]",
    "fe80::1%eth0",
    "[::1",
    "::1]",
    "1.2.3.4/33",
    "::/129",
    "10.0.0.0/-1",
    "::/1.5",
    "::/01",
    "::/",
    "::/1/2",
    "example.com/24",
  ])("refuses invalid entry %s", (entry) => {
    expect(() => parseNetworkAllowlist(["valid.test", entry, "also invalid!"])).toThrow(`"${entry}"`);
  });

  test.each(["0.0.0.0/0", "::/0", "10.0.0.1/0"])("refuses all-address network %s", (entry) => {
    expect(() => parseNetworkAllowlist([entry])).toThrow(`"${entry}"`);
    expect(() => parseNetworkAllowlist([entry])).toThrow("a /0 network allows every address");
  });

  test("accepts /1 networks", () => {
    expect(parseNetworkAllowlist(["0.0.0.0/1", "::/1"]).networks).toEqual([
      { address: "0.0.0.0", family: 4, bits: 1 },
      { address: "::", family: 6, bits: 1 },
    ]);
  });

  test("refuses host bits and names the correct canonical network", () => {
    expect(() => parseNetworkAllowlist(["10.0.0.5/8"])).toThrow("10.0.0.0/8");
    expect(() => parseNetworkAllowlist(["fd00::5/64"])).toThrow("fd00::/64");
  });

  test("matches IPv4 and IPv6 boundaries, mapped IPv4, and no other embeddings", () => {
    const list = parseNetworkAllowlist(["10.0.0.0/8", "fd00::/64", "127.0.0.1/32"]);
    for (const address of [
      "10.0.0.0",
      "10.255.255.255",
      "fd00::",
      "fd00::ffff:ffff:ffff:ffff",
      "127.0.0.1",
      "::ffff:10.0.0.5",
      "[::ffff:a00:5]",
    ]) {
      expect(isAllowlistedNetworkAddress(list, address)).toBe(true);
    }
    for (const address of ["11.0.0.0", "fd00:0:0:1::", "127.0.0.2", "64:ff9b::a00:5", "2002:a00:5::", "2001::a00:5", "::a00:5", "bad"]) {
      expect(isAllowlistedNetworkAddress(list, address)).toBe(false);
    }
    expect(isAllowlistedNetworkAddress(parseNetworkAllowlist(["64:ff9b::/96"]), "64:ff9b::a00:5")).toBe(true);
    expect(isAllowlistedNetworkAddress(EMPTY_NETWORK_ALLOWLIST, "127.0.0.1")).toBe(false);
    expect(isAllowlistedNetworkAddress(parseNetworkAllowlist(["[::ffff:10.0.0.5]"]), "::ffff:a00:5")).toBe(true);
  });
});

test("env allowlist parsing retains the policy and names invalid configuration", () => {
  expect(parseNetworkAllowlistEnv("APP_ALLOWED_TARGETS", ["storage.test", "10.20.0.0/16"])).toEqual(
    parseNetworkAllowlist(["storage.test", "10.20.0.0/16"]),
  );
  expect(parseNetworkAllowlistEnv("APP_ALLOWED_TARGETS", [])).toEqual(EMPTY_NETWORK_ALLOWLIST);
  expect(() => parseNetworkAllowlistEnv("APP_ALLOWED_TARGETS", ["0.0.0.0/0"])).toThrow(
    "APP_ALLOWED_TARGETS: Invalid network allowlist entry",
  );
});
