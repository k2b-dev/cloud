import { expect, test } from "bun:test";
import { addressPrefix } from "../server/request-context/address";
import { appLoginAddressMatches, appLoginAddressProof } from "./login-address-store";

test("request salts differ and only equal public prefixes match", () => {
  const first = appLoginAddressProof("8.8.8.8");
  const second = appLoginAddressProof("8.8.8.8");
  expect(first.salt).not.toBe(second.salt);
  expect(first.digest).not.toBe(second.digest);
  expect(Object.keys(first)).toEqual(["salt", "digest"]);
  expect(appLoginAddressMatches(first, "8.8.8.8")).toBe(true);
  expect(appLoginAddressMatches(first, "8.8.4.4")).toBe(false);
  const prefix = addressPrefix("2606:4700:4700:1::1")!;
  const v6 = appLoginAddressProof(prefix);
  expect(appLoginAddressMatches(v6, addressPrefix("2606:4700:4700:1::ffff")!)).toBe(true);
  expect(appLoginAddressMatches(v6, addressPrefix("2606:4700:4700:2::1")!)).toBe(false);
  expect(appLoginAddressMatches({ salt: "bad", digest: "bad" }, prefix)).toBe(false);
});
