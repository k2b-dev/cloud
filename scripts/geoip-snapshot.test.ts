import { expect, test } from "bun:test";
import { rewriteGeoIpPin } from "./geoip-snapshot";

test("rewrites exactly the pinned URLs and gzip checksums in the geoip layer", async () => {
  const original = await Bun.file(new URL("../Dockerfile", import.meta.url)).text();
  const pin = { month: "2026-11", city: "a".repeat(64), asn: "b".repeat(64) };
  const updated = rewriteGeoIpPin(original, pin);
  expect(updated).toContain("dbip-city-lite-2026-11.mmdb.gz");
  expect(updated).toContain("dbip-asn-lite-2026-11.mmdb.gz");
  expect(updated).toContain(`${pin.city}  /geoip/dbip-city-lite.mmdb.gz`);
  expect(updated).toContain(`${pin.asn}  /geoip/dbip-asn-lite.mmdb.gz`);
  expect(updated.slice(0, updated.indexOf("AS geoip"))).toBe(original.slice(0, original.indexOf("AS geoip")));
  expect(updated.slice(updated.indexOf("# Stage 5:"))).toBe(original.slice(original.indexOf("# Stage 5:")));
  expect(rewriteGeoIpPin(updated, pin)).toBe(updated);
  expect(() => rewriteGeoIpPin("RUN true", pin)).toThrow("Expected one city");
  expect(() => rewriteGeoIpPin(original, { ...pin, month: "2026-13" })).toThrow("Invalid");
  expect(() => rewriteGeoIpPin(original + original, pin)).toThrow("Expected one city");
});
