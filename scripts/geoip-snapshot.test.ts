import { expect, test } from "bun:test";
import { rewriteGeoIpPin } from "./geoip-snapshot";

test("rewrites exactly the snapshot reference and gzip checksums in the geoip stages", async () => {
  const original = await Bun.file(new URL("../Dockerfile", import.meta.url)).text();
  const pin = { month: "2026-11", city: "a".repeat(64), asn: "b".repeat(64) };
  const updated = rewriteGeoIpPin(original, pin);
  expect(updated).toContain("ghcr.io/k2b-dev/mirror/dbip-lite:2026-11 AS geoip-snapshot");
  expect(updated).toContain(`${pin.city}  dbip-city-lite.mmdb.gz`);
  expect(updated).toContain(`${pin.asn}  dbip-asn-lite.mmdb.gz`);
  expect(updated.slice(0, updated.indexOf("# Stage 4:"))).toBe(original.slice(0, original.indexOf("# Stage 4:")));
  expect(updated.slice(updated.indexOf("# Stage 6:"))).toBe(original.slice(original.indexOf("# Stage 6:")));
  expect(rewriteGeoIpPin(updated, pin)).toBe(updated);
  expect(() => rewriteGeoIpPin("RUN true", pin)).toThrow("Expected one DB-IP snapshot reference");
  expect(() => rewriteGeoIpPin(original, { ...pin, month: "2026-13" })).toThrow("Invalid");
  expect(() => rewriteGeoIpPin(original + original, pin)).toThrow("Expected one DB-IP snapshot reference");
  for (const kind of ["city", "asn"]) {
    const checksum = new RegExp(`[a-f0-9]{64}  dbip-${kind}-lite\\.mmdb\\.gz`);
    expect(() => rewriteGeoIpPin(original.replace(checksum, ""), pin)).toThrow(`Expected one ${kind} checksum`);
    expect(() => rewriteGeoIpPin(`${original}\n${original.match(checksum)?.[0]}`, pin)).toThrow(`Expected one ${kind} checksum`);
  }
});
