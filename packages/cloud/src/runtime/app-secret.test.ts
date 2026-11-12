import { expect, test } from "bun:test";
import { appSecretRingId, appSecretRootId, appSecretRoots, validateAppSecretRing } from "./app-secret";

test("root fingerprints are stable HMAC identifiers and the complete ordered ring changes cache identity", () => {
  // Independently calculated HMAC-SHA256 vector; root bytes stay private.
  expect(appSecretRootId("root-vector")).toBe("3piL-G8O_aadwDNM");
  const ring = { current: "ab".repeat(32), previous: "cd".repeat(32) };
  expect(appSecretRoots(ring)).toEqual([ring.current, ring.previous]);
  expect(appSecretRingId(ring)).not.toBe(appSecretRingId({ current: ring.current }));
  expect(appSecretRingId(ring)).not.toBe(appSecretRingId({ current: ring.current, next: ring.previous }));
});

test("rotation rejects simultaneous overlap roots, invalid NEXT and equivalent legacy encryption roots", () => {
  const current = "ab".repeat(32),
    next = "cd".repeat(32);
  expect(() => validateAppSecretRing({ current, next })).not.toThrow();
  expect(() => validateAppSecretRing({ current, previous: "old passphrase" })).not.toThrow();
  expect(() => validateAppSecretRing({ current, previous: "old", next })).toThrow("must not both");
  expect(() => validateAppSecretRing({ current, next: "short" })).toThrow("64 hex");
  expect(() => validateAppSecretRing({ current, previous: ` ${current.toUpperCase()} ` })).toThrow("distinct");
});
