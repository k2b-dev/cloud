import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as logging from "../../services/logging";
import { createGeoIp, openGeoIpDatabase, truncateUtf8 } from "./geoip";
import { mmdbFixture } from "./geoip.test-fixture";

const directories: string[] = [];
let restoreLog: () => void;
beforeEach(() => {
  restoreLog = quiet().restore;
});
afterEach(() => restoreLog());
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const paths = (city = mmdbFixture("city"), asn = mmdbFixture("asn")) => {
  const dir = mkdtempSync(join(tmpdir(), "cloud-geoip-"));
  directories.push(dir);
  const result = { cityPath: join(dir, "city.mmdb"), asnPath: join(dir, "asn.mmdb") };
  writeFileSync(result.cityPath, city);
  writeFileSync(result.asnPath, asn);
  return result;
};
const quiet = () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const log = spyOn(logging, "logger").mockReturnValue({ warn, info: () => {}, debug: () => {}, error: () => {} });
  return {
    warn,
    restore() {
      log.mockRestore();
      warn.mockRestore();
    },
  };
};

describe("GeoIP", () => {
  test("opens lazily and resolves locale, IPv4 subtree, IPv6 and ASN", () => {
    const files = paths();
    const geo = createGeoIp(files);
    // Opening on first use must observe the current bytes, not construction time.
    writeFileSync(files.cityPath, mmdbFixture("city"));
    for (const locale of ["de", "de-AT"])
      expect(geo.lookup("8.8.8.8", locale)).toEqual({
        cityDatabase: true,
        asnDatabase: true,
        country: "AT",
        city: "Wien",
        network: "Example Net GmbH",
      });
    expect(geo.lookup("8.8.8.8", "fr").city).toBe("Vienna");
    expect(geo.lookup("2a01:4f8::1").city).toBe("Zürich");
    for (const address of ["9.9.9.9", "10.0.0.1", "::1", null])
      expect(geo.lookup(address)).toEqual({ cityDatabase: true, asnDatabase: true, country: null, city: null, network: null });
    const info = geo.status();
    expect(info.city?.databaseType).toBe("DBIP-City-Lite");
    expect(info.asn?.databaseType).toContain("ASN");
    expect(info.city?.buildDate.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(info.city?.source).toBe("bundled");
  });
  test("cleans and bounds names by UTF-8 bytes and rejects ZZ", () => {
    const result = createGeoIp(paths()).lookup("1.1.1.1");
    expect(result.country).toBeNull();
    expect(result.city).toBe("界😀".repeat(13) + "界");
    for (const name of [result.city!, result.network!]) {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(96);
      expect(name).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202e\u2066]/);
      expect(name).not.toContain("  ");
    }
  });
  test("missing files stay unavailable and log once per database", () => {
    const logs = quiet();
    try {
      const files = paths();
      rmSync(files.cityPath);
      rmSync(files.asnPath);
      const geo = createGeoIp(files);
      expect(logs.warn).toHaveBeenCalledTimes(0);
      for (let i = 0; i < 2; i++)
        expect(geo.lookup("8.8.8.8")).toEqual({ cityDatabase: false, asnDatabase: false, country: null, city: null, network: null });
      expect(geo.status()).toEqual({ city: null, asn: null });
      expect(logs.warn).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("8.8.8.8");
    } finally {
      logs.restore();
    }
  });
  test("status opens once and an absent ASN database preserves city results", () => {
    const logs = quiet();
    try {
      const files = paths();
      rmSync(files.asnPath);
      const geo = createGeoIp(files);
      expect(geo.status().city?.source).toBe("bundled");
      expect(geo.status().asn).toBeNull();
      rmSync(files.cityPath);
      for (let i = 0; i < 2; i++)
        expect(geo.lookup("8.8.8.8", "de")).toEqual({
          cityDatabase: true,
          asnDatabase: false,
          country: "AT",
          city: "Wien",
          network: null,
        });
      expect(logs.warn).toHaveBeenCalledTimes(1);
    } finally {
      logs.restore();
    }
  });
  test("corruption and invalid metadata fail closed once", () => {
    const logs = quiet();
    try {
      for (const bytes of [
        Buffer.from([1, 2, 3, 4]),
        mmdbFixture("city").subarray(0, 100),
        mmdbFixture("city", { databaseType: "Wrong" }),
        mmdbFixture("city", { ipVersion: 5 }),
      ]) {
        const before = logs.warn.mock.calls.length;
        const geo = createGeoIp(paths(bytes));
        for (let i = 0; i < 2; i++) expect(geo.lookup("8.8.8.8").cityDatabase).toBe(false);
        expect(logs.warn.mock.calls.length - before).toBe(1);
        expect(geo.lookup("8.8.8.8").asnDatabase).toBe(true);
      }
    } finally {
      logs.restore();
    }
  });
  test("data decoding failure returns no result and logs once without address", () => {
    const logs = quiet();
    try {
      const geo = createGeoIp(paths(mmdbFixture("city", { corruptData: true })));
      for (let i = 0; i < 2; i++) expect(geo.lookup("8.8.8.8").city).toBeNull();
      expect(logs.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("8.8.8.8");
    } finally {
      logs.restore();
    }
  });
  test("opens byte views at their offset", () => {
    const bytes = mmdbFixture("city");
    const padded = Buffer.concat([Buffer.alloc(5), bytes, Buffer.alloc(3)]);
    const database = openGeoIpDatabase("city", padded.subarray(5, 5 + bytes.length), "bundled");
    expect(database?.reader.get("8.8.8.8")).toHaveProperty("country.iso_code", "at");
    expect(openGeoIpDatabase("asn", bytes)).toBeNull();
  });
});

test("truncateUtf8 preserves complete code points at every boundary", () => {
  for (const value of ["é", "界", "😀", "aé界😀"]) {
    const size = Buffer.byteLength(value);
    expect(truncateUtf8(value, size)).toBe(value);
    for (let limit = 0; limit <= size + 1; limit++) {
      const result = truncateUtf8(value, limit);
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(limit);
      expect(Buffer.from(result).toString()).toBe(result);
      expect(result.isWellFormed()).toBe(true);
    }
    expect(truncateUtf8(value, size - 1)).not.toBe(value);
  }
  expect(truncateUtf8("a\ud800b\udc00", 96)).toBe("ab");
});
