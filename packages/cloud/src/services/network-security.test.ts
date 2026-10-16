import { describe, expect, mock, test } from "bun:test";
import { EMPTY_NETWORK_ALLOWLIST, isUnsafeNetworkAddress, parseNetworkAllowlist } from "../shared/network-address";
import {
  isNetworkTargetBlocked,
  NetworkTargetBlockedError,
  type PublicNetworkAddress,
  pinnedNetworkLookup,
  resolveAllowedNetworkAddresses,
  resolvePublicNetworkAddresses,
} from "./network-security";

describe("public network target resolution", () => {
  test("classifies private, reserved, mapped, and public addresses", () => {
    expect(isUnsafeNetworkAddress("10.0.0.1")).toBe(true);
    expect(isUnsafeNetworkAddress("100.64.0.1")).toBe(true);
    expect(isUnsafeNetworkAddress("203.0.113.1")).toBe(true);
    expect(isUnsafeNetworkAddress("::1")).toBe(true);
    expect(isUnsafeNetworkAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isUnsafeNetworkAddress("fc00::1")).toBe(true);
    expect(isUnsafeNetworkAddress("2001:db8::1")).toBe(true);
    expect(isUnsafeNetworkAddress("3fff:fff::1")).toBe(true);
    expect(isUnsafeNetworkAddress("1.1.1.1")).toBe(false);
    expect(isUnsafeNetworkAddress("2606:4700:4700::1111")).toBe(false);
  });

  test("rejects private DNS answers and mixed public-private answers", async () => {
    const privateLookup = async () => [{ address: "127.0.0.1", family: 4 }];
    const mixedLookup = async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ];

    await expect(resolvePublicNetworkAddresses("push.example", privateLookup)).rejects.toThrow("private or reserved");
    await expect(resolvePublicNetworkAddresses("push.example", mixedLookup)).rejects.toThrow("private or reserved");
  });

  test("returns validated public addresses", async () => {
    const expected: PublicNetworkAddress[] = [
      { address: "1.1.1.1", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    const lookup = async () => expected;

    await expect(resolvePublicNetworkAddresses("push.example", lookup)).resolves.toEqual(expected);
  });
});

describe("fail-closed network resolution and pinned sockets", () => {
  test("refuses every unsafe literal form without consulting DNS", async () => {
    const lookup = mock(async () => [{ address: "8.8.8.8", family: 4 }]);
    for (const host of [
      "127.1",
      "2130706433",
      "0x7f000001",
      "0177.0.0.1",
      "0x7f.1",
      "[::ffff:127.0.0.1]",
      "[::ffff:7f00:1]",
      "::ffff:7f00:1",
      "1.2.3.4.5",
      "fe80::1%eth0",
      "[[2606:4700::1111]]",
      "[2606:4700::1111",
    ]) {
      await expect(resolvePublicNetworkAddresses(host, lookup)).rejects.toBeInstanceOf(NetworkTargetBlockedError);
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  test("returns canonical public literals without DNS", async () => {
    const lookup = mock(async () => []);
    await expect(resolvePublicNetworkAddresses("0x08080808", lookup)).resolves.toEqual([{ address: "8.8.8.8", family: 4 }]);
    await expect(resolvePublicNetworkAddresses("[::ffff:8.8.8.8]", lookup)).resolves.toEqual([{ address: "::ffff:808:808", family: 6 }]);
    expect(lookup).not.toHaveBeenCalled();
  });

  test("preserves DNS errors, rejects empty answers, and requests every answer verbatim", async () => {
    const error = Object.assign(new Error("missing"), { code: "ENOTFOUND" });
    await expect(
      resolvePublicNetworkAddresses("missing.example", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    await expect(resolvePublicNetworkAddresses("missing.example", async () => [])).rejects.toThrow("Network target could not be resolved");
    const lookup = mock(async () => [{ address: "8.8.8.8", family: 4 }]);
    await resolvePublicNetworkAddresses("PUBLIC.EXAMPLE.", lookup);
    expect(lookup).toHaveBeenCalledWith("public.example", { all: true, verbatim: true });
  });

  test("policy refusals carry a typed error", async () => {
    const answers: Array<Array<{ address: string; family: number }>> = [
      [
        { address: "8.8.8.8", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
      [{ address: "8.8.8.8", family: 9 }],
      [{ address: "invalid", family: 4 }],
      [{ address: "2606:4700:4700::1111", family: 4 }],
    ];
    for (const addresses of answers) {
      await expect(resolvePublicNetworkAddresses("public.example", async () => addresses)).rejects.toBeInstanceOf(
        NetworkTargetBlockedError,
      );
    }
  });

  test("pinned lookup honors family and all without resolving a hostname", () => {
    const addresses: PublicNetworkAddress[] = [
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ];
    const lookup = pinnedNetworkLookup(addresses);
    lookup("never-resolve.test", { family: 6 }, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe(addresses[1]!.address);
      expect(family).toBe(6);
    });
    lookup("never-resolve.test", { all: true }, (error, all) => {
      expect(error).toBeNull();
      expect(all).toEqual(addresses);
    });
    lookup("never-resolve.test", { family: 4, all: true }, (error, all) => {
      expect(error).toBeNull();
      expect(all).toEqual([addresses[0]!]);
    });
    pinnedNetworkLookup([addresses[0]!])("never-resolve.test", { family: 6 }, (error) => expect(error?.code).toBe("ENOTFOUND"));
    pinnedNetworkLookup([])("never-resolve.test", { all: true }, (error) => expect(error?.code).toBe("ENOTFOUND"));
  });
});

describe("allowlisted network resolution", () => {
  test.each(["127.0.0.1", "10.0.0.5", "::1", "fd00::1", "::ffff:127.0.0.1", "[::ffff:7f00:1]"])(
    "empty allowlist refuses %s",
    async (host) => {
      await expect(resolveAllowedNetworkAddresses(host, EMPTY_NETWORK_ALLOWLIST)).rejects.toBeInstanceOf(NetworkTargetBlockedError);
    },
  );

  test("allows a network literal and DNS answers only when every answer is public or allowed", async () => {
    const list = parseNetworkAllowlist(["10.0.0.0/8"]);
    await expect(resolveAllowedNetworkAddresses("10.0.0.5", list)).resolves.toEqual([{ address: "10.0.0.5", family: 4 }]);
    await expect(
      resolveAllowedNetworkAddresses("metrics.test", list, async () => [
        { address: "10.0.0.5", family: 4 },
        { address: "8.8.8.8", family: 4 },
      ]),
    ).resolves.toHaveLength(2);
    await expect(
      resolveAllowedNetworkAddresses("metrics.test", list, async () => [
        { address: "10.0.0.5", family: 4 },
        { address: "192.168.0.1", family: 4 },
      ]),
    ).rejects.toBeInstanceOf(NetworkTargetBlockedError);
    await expect(resolveAllowedNetworkAddresses("::ffff:10.0.0.5", list)).resolves.toHaveLength(1);
    await expect(resolveAllowedNetworkAddresses("64:ff9b::a00:5", list)).rejects.toBeInstanceOf(NetworkTargetBlockedError);
  });

  test.each(["localhost", "metrics.internal", "metrics.local"])("reserved name %s requires an exact host entry", async (host) => {
    const lookup = async () => [{ address: "10.0.0.5", family: 4 }];
    await expect(resolveAllowedNetworkAddresses(host, parseNetworkAllowlist(["10.0.0.0/8"]), lookup)).rejects.toBeInstanceOf(
      NetworkTargetBlockedError,
    );
    await expect(resolveAllowedNetworkAddresses(host.toUpperCase() + ".", parseNetworkAllowlist([host]), lookup)).resolves.toHaveLength(1);
  });

  test("exact host trust never skips DNS failures, empty answers or address validation", async () => {
    const list = parseNetworkAllowlist(["metrics.test"]);
    for (const lookup of [
      async () => {
        throw new Error("no DNS");
      },
      async () => [],
    ]) {
      try {
        await resolveAllowedNetworkAddresses("metrics.test", list, lookup);
        throw new Error("expected lookup to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(NetworkTargetBlockedError);
        expect(error instanceof Error ? error.message : "").not.toBe("expected lookup to fail");
      }
    }
    for (const answer of [
      { address: "bad", family: 4 },
      { address: "127.0.0.1", family: 9 },
      { address: "::1", family: 4 },
    ]) {
      await expect(resolveAllowedNetworkAddresses("metrics.test", list, async () => [answer])).rejects.toBeInstanceOf(
        NetworkTargetBlockedError,
      );
    }
    await expect(
      resolveAllowedNetworkAddresses("other.test", list, async () => [{ address: "127.0.0.1", family: 4 }]),
    ).rejects.toBeInstanceOf(NetworkTargetBlockedError);
  });
});

test("save-time policy hint refuses only known blocked targets", async () => {
  const allowlist = EMPTY_NETWORK_ALLOWLIST;
  expect(await isNetworkTargetBlocked("127.0.0.1", allowlist)).toBe(true);
  expect(
    await isNetworkTargetBlocked("example.test", allowlist, {
      resolve: async () => {
        throw new NetworkTargetBlockedError("Blocked");
      },
    }),
  ).toBe(true);
  expect(
    await isNetworkTargetBlocked("example.test", allowlist, {
      resolve: async () => {
        throw new Error("Lookup failed");
      },
    }),
  ).toBe(false);
  expect(await isNetworkTargetBlocked("example.test", allowlist, { resolve: async () => [] })).toBe(false);
  expect(await isNetworkTargetBlocked("example.test", allowlist, { resolve: () => new Promise(() => {}), timeoutMs: 1 })).toBe(false);
  expect(await isNetworkTargetBlocked("127.0.0.1", parseNetworkAllowlist(["127.0.0.1"]))).toBe(false);
});
