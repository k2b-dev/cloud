import { describe, expect, test } from "bun:test";
import { isUnsafeNetworkAddress } from "../shared/network-address";
import { type PublicNetworkAddress, resolvePublicNetworkAddresses } from "./network-security";

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
