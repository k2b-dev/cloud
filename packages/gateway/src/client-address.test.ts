import { describe, expect, test } from "bun:test";
import { DEFAULT_TRUSTED_PROXIES, resolveClientAddress, trustedProxySet } from "./client-address";

const defaults = trustedProxySet(DEFAULT_TRUSTED_PROXIES);
const nobody = trustedProxySet([]);

describe("client address", () => {
  test("ignores a forwarded header from a peer that is not a trusted proxy", () => {
    expect(resolveClientAddress("198.51.100.7", "203.0.113.10", defaults)).toEqual({
      address: "203.0.113.10",
      forwardedFor: "203.0.113.10",
    });
    expect(resolveClientAddress("198.51.100.7", "172.18.0.2", nobody)).toEqual({ address: "172.18.0.2", forwardedFor: "172.18.0.2" });
  });

  test("takes the right-most address that is not a trusted proxy and drops what the client prepended", () => {
    // Traefik on a Docker network appended the real client to a spoofed entry.
    expect(resolveClientAddress("198.51.100.7, 203.0.113.10", "172.18.0.2", defaults)).toEqual({
      address: "203.0.113.10",
      forwardedFor: "203.0.113.10, 172.18.0.2",
    });
    // A CDN in front of Traefik is only trusted when it is configured.
    const behindCdn = "198.51.100.7, 203.0.113.10, 192.0.2.44";
    expect(resolveClientAddress(behindCdn, "172.18.0.2", defaults)?.address).toBe("192.0.2.44");
    const withCdn = trustedProxySet([...DEFAULT_TRUSTED_PROXIES, "192.0.2.0/24"]);
    expect(resolveClientAddress(behindCdn, "172.18.0.2", withCdn)).toEqual({
      address: "203.0.113.10",
      forwardedFor: "203.0.113.10, 192.0.2.44, 172.18.0.2",
    });
  });

  test("keeps a client on a private network when every hop is trusted", () => {
    expect(resolveClientAddress("192.168.1.20", "172.18.0.2", defaults)).toEqual({
      address: "192.168.1.20",
      forwardedFor: "192.168.1.20, 172.18.0.2",
    });
    expect(resolveClientAddress(null, "172.18.0.2", defaults)?.address).toBe("172.18.0.2");
    expect(resolveClientAddress("", "172.18.0.2", defaults)?.address).toBe("172.18.0.2");
  });

  test("handles IPv6 peers, hops and IPv4-mapped addresses", () => {
    expect(resolveClientAddress("2001:DB8::1", "fd00:cafe::2", defaults)).toEqual({
      address: "2001:db8::1",
      forwardedFor: "2001:db8::1, fd00:cafe::2",
    });
    // Bun reports IPv4 peers on a dual-stack socket in IPv4-mapped form.
    expect(resolveClientAddress("203.0.113.10", "::ffff:172.18.0.2", defaults)).toEqual({
      address: "203.0.113.10",
      forwardedFor: "203.0.113.10, 172.18.0.2",
    });
    expect(resolveClientAddress(null, "::ffff:203.0.113.10", defaults)?.address).toBe("203.0.113.10");
    expect(resolveClientAddress("2001:db8::1", "::1", trustedProxySet(["::1"]))?.address).toBe("2001:db8::1");
  });

  test("stops at a malformed hop and never forwards it", () => {
    for (const malformed of ["not-an-ip", "203.0.113.10:4711", "[2001:db8::1]", "unknown", "", "203.0.113.256"]) {
      expect(resolveClientAddress(malformed, "172.18.0.2", defaults)).toEqual({ address: "172.18.0.2", forwardedFor: "172.18.0.2" });
    }
    expect(resolveClientAddress("203.0.113.10, garbage, 10.0.0.5", "172.18.0.2", defaults)).toEqual({
      address: "10.0.0.5",
      forwardedFor: "10.0.0.5, 172.18.0.2",
    });
    // Anything left of the client is the client's own claim and may be garbage.
    expect(resolveClientAddress("garbage, 203.0.113.10", "172.18.0.2", defaults)?.address).toBe("203.0.113.10");
  });

  test("forwards no address when the peer is unknown", () => {
    expect(resolveClientAddress("203.0.113.10", null, defaults)).toBeNull();
  });

  test("rejects malformed trusted-proxy entries", () => {
    for (const entry of ["10.0.0.0/33", "fd00::/129", "10.0.0.0/8/8", "10.0.0.0/x", "proxy", "fe80::1%eth0", "10.0.0.0/"]) {
      expect(() => trustedProxySet([entry])).toThrow("GATEWAY_TRUSTED_PROXIES");
    }
    const exact = trustedProxySet(["172.18.0.2", "2001:db8::/32"]);
    expect(resolveClientAddress("203.0.113.10", "172.18.0.2", exact)?.address).toBe("203.0.113.10");
    expect(resolveClientAddress("203.0.113.10", "172.18.0.3", exact)?.address).toBe("172.18.0.3");
    expect(resolveClientAddress("203.0.113.10", "2001:db8:ffff::9", exact)?.address).toBe("203.0.113.10");
  });
});
