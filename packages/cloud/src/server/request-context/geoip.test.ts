import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as logging from "../../services/logging";
import { createGeoIp, hasBoundedMmdbMetadata, openGeoIpDatabase, truncateUtf8 } from "./geoip";
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
  const metadata = (payload: Uint8Array) => Buffer.concat([Buffer.from("abcdef4d61784d696e642e636f6d", "hex"), payload]);

  test("metadata pre-check handles scalar payloads, extended sizes and pointer widths", () => {
    for (const payload of [
      [0x40],
      [0x68, ...Array(8).fill(0)],
      [0x80],
      [0xa2, 0, 0],
      [0xc4, 0, 0, 0, 0],
      [0xe0],
      [0x04, 1, 0, 0, 0, 0],
      [0x08, 2, ...Array(8).fill(0)],
      [0x10, 3, ...Array(16).fill(0)],
      [0x02, 4, 0, 7, 1, 7],
      [0x04, 8, 0, 0, 0, 0],
      [0x5d, 0, ...Array(29).fill(0)],
      [0x5e, 0, 0, ...Array(285).fill(0)],
      [0x5f, 0, 0, 0, ...Array(65821).fill(0)],
      [0x20, 2, 0x40],
      [0x28, 0, 0, ...Array(2045).fill(0), 0x40],
      [0x38, 0, 0, 0, 5, 0x40],
    ])
      expect(hasBoundedMmdbMetadata(metadata(Buffer.from(payload)))).toBe(true);
  });

  test("metadata pre-check rejects cycles, bad offsets, types, sizes and truncated controls", () => {
    for (const payload of [
      [],
      [0x20, 0],
      [0x20, 2],
      [0x28, 0, 0],
      [0x30, 0, 0, 0],
      [0x38, 255, 255, 255, 255],
      [0x38, 0],
      [0],
      [0, 0],
      [0, 9],
      [0x5d],
      [0x5e, 0],
      [0x5f, 0, 0],
      [0x41],
      [0xe1, 0x40],
      [0x67, ...Array(7).fill(0)],
      [2, 7],
      [5, 1, 0, 0, 0, 0, 0],
      [5, 8, 0, 0, 0, 0, 0],
    ])
      expect(hasBoundedMmdbMetadata(metadata(Buffer.from(payload)))).toBe(false);
  });

  test("map keys must be strings, inline or through one bounded pointer", () => {
    for (const payload of [
      [0xe1, 0x40, 0x40],
      [0xe1, 0x20, 4, 0x40, 0x40],
    ])
      expect(hasBoundedMmdbMetadata(metadata(Buffer.from(payload)))).toBe(true);
    for (const payload of [
      [0xe1, 0xc0, 0x40],
      [0xe1, 0, 4, 0x40],
      [0xe1, 0x20, 4, 0x40, 0xc0],
      [0xe1, 0x20, 4, 0x40, 0x20, 6, 0x40],
      [0xe1, 0x20, 4, 0x40, 0x41],
    ])
      expect(hasBoundedMmdbMetadata(metadata(Buffer.from(payload)))).toBe(false);
  });

  test("metadata pre-check uses the last marker and walks deep nesting without recursion", () => {
    const valid = metadata(Buffer.from([0x40]));
    expect(hasBoundedMmdbMetadata(Buffer.concat([valid, metadata(Buffer.from([0x41]))]))).toBe(false);
    expect(hasBoundedMmdbMetadata(Buffer.concat([metadata(Buffer.from([0x41])), valid]))).toBe(true);
    expect(hasBoundedMmdbMetadata(metadata(Buffer.from([...Array(4000).fill([1, 4]).flat(), 0x40])))).toBe(true);
    expect(hasBoundedMmdbMetadata(Buffer.concat([Buffer.alloc(7), valid]).subarray(7))).toBe(true);
    expect(hasBoundedMmdbMetadata(Buffer.concat([valid, Buffer.alloc(128 * 1024 - valid.length)]))).toBe(true);
    expect(hasBoundedMmdbMetadata(Buffer.concat([valid, Buffer.alloc(128 * 1024 - valid.length + 1)]))).toBe(false);
  });

  test("metadata pre-check counts the payload bytes of a shared string once per reference", () => {
    const text = [0x5e, ...[(8000 - 285) >> 8, (8000 - 285) & 255], ...Array(8000).fill(0x41)];
    // An array of 64 pointers to one 8,000-byte string decodes 512 KB from about 8 KB.
    const shared = [0x1d, 4, 64 - 29, ...Array(64).fill([0x20, 131]).flat(), ...text];
    expect(hasBoundedMmdbMetadata(metadata(Buffer.from(shared)))).toBe(false);
    expect(hasBoundedMmdbMetadata(metadata(Buffer.from([0x01, 4, 0x20, 4, ...text])))).toBe(true);
  });

  test("metadata may share a string beyond its encoded size, up to the 128 KiB section limit", () => {
    const twice = (text: number[]) => metadata(Buffer.from([0x02, 4, 0x20, 6, 0x20, 6, ...text]));
    // Two references to one 480-byte string decode more than the 489 encoded bytes.
    expect(hasBoundedMmdbMetadata(twice([0x5e, 0, 480 - 285, ...Array(480).fill(0x41)]))).toBe(true);
    // Two references to one 66,000-byte string fit the section but decode more than 128 KiB.
    expect(hasBoundedMmdbMetadata(twice([0x5f, 0, 0, 66000 - 65821, ...Array(66000).fill(0x41)]))).toBe(false);
  });

  test("metadata pre-check checks the section mmdb-lib decodes when its scan skips the last marker", () => {
    // mmdb-lib's backward scan misses a marker followed by "Mind.com" and falls back to the earlier section.
    const decoy = metadata(Buffer.from("Mind.comxxxxxx"));
    expect(hasBoundedMmdbMetadata(Buffer.concat([mmdbFixture("city", { metadataPointerDepth: 24 }), decoy]))).toBe(false);
    expect(hasBoundedMmdbMetadata(Buffer.concat([mmdbFixture("city"), decoy]))).toBe(true);
  });

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
        mmdbFixture("city", { ipVersion: 4 }),
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
    expect(database?.get("8.8.8.8")).toHaveProperty("country.iso_code", "at");
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

const uploaded = (type = "GeoLite2-City", sha256 = "a".repeat(64)) => {
  const database = openGeoIpDatabase("city", mmdbFixture("city", { databaseType: type }), "uploaded")!;
  database.info.sha256 = sha256;
  return database;
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("uploaded source wins and an absent row returns to the bundled snapshot", async () => {
  let versions: { city?: string } = { city: "a".repeat(64) };
  const geo = createGeoIp({
    paths: paths(),
    uploads: {
      versions: async () => versions,
      read: async () => mmdbFixture("city", { databaseType: "GeoLite2-City" }),
    },
  });
  await geo.refresh();
  expect(geo.status().city).toMatchObject({ source: "uploaded", databaseType: "GeoLite2-City", sha256: versions.city });
  versions = {};
  await geo.refresh();
  expect(geo.status().city).toMatchObject({ source: "bundled", databaseType: "DBIP-City-Lite" });
  expect(geo.status().city?.sha256).toBeUndefined();
});

test("lookups keep their current reader during a single-flight refresh", async () => {
  const waiting = deferred<Uint8Array | null>();
  let checks = 0;
  let reads = 0;
  const geo = createGeoIp({
    paths: paths(),
    uploads: {
      versions: async () => {
        checks++;
        return { city: "a".repeat(64) };
      },
      read: async () => {
        reads++;
        return waiting.promise;
      },
    },
  });
  const refresh = geo.refresh();
  await Promise.resolve();
  await Promise.resolve();
  expect(reads).toBe(1);
  for (let i = 0; i < 10; i++) expect(geo.lookup("8.8.8.8").city).toBe("Vienna");
  expect(geo.refresh()).toBe(refresh);
  expect(geo.status().city?.source).toBe("bundled");
  waiting.resolve(mmdbFixture("city", { databaseType: "GeoLite2-City", cityName: "Uploaded City" }));
  await refresh;
  expect(geo.status().city?.source).toBe("uploaded");
  expect(checks).toBe(1);
  expect(reads).toBe(1);
  expect(geo.lookup("8.8.8.8").city).toBe("Uploaded City");
});

test("a slow refresh cannot overwrite a newer install or reset, even while versions is pending", async () => {
  for (const reset of [false, true]) {
    for (const slowVersions of [false, true]) {
      const version = deferred<{ city: string }>();
      const bytes = deferred<Uint8Array | null>();
      const geo = createGeoIp({
        paths: paths(),
        uploads: {
          versions: () => (slowVersions ? version.promise : Promise.resolve({ city: "a".repeat(64) })),
          read: () => (slowVersions ? Promise.resolve(mmdbFixture("city")) : bytes.promise),
        },
      });
      geo.install("city", uploaded("New-City", "b".repeat(64)));
      const refresh = geo.refresh();
      await Promise.resolve();
      geo.install("city", reset ? null : uploaded("Newest-City", "c".repeat(64)));
      version.resolve({ city: "a".repeat(64) });
      bytes.resolve(mmdbFixture("city"));
      await refresh;
      expect(geo.status().city?.databaseType).toBe(reset ? "DBIP-City-Lite" : "Newest-City");
    }
  }
});

test("versions and read failures preserve both readers and log only once", async () => {
  let failing: "versions" | "read" = "versions";
  const logs = quiet();
  try {
    const geo = createGeoIp({
      paths: paths(),
      uploads: {
        versions: async () => {
          if (failing === "versions") throw new Error("private");
          return { city: "a".repeat(64) };
        },
        read: async () => {
          throw new Error("private");
        },
      },
    });
    geo.install("city", uploaded());
    await geo.refresh();
    failing = "read";
    geo.install("city", uploaded("New-City", "b".repeat(64)));
    await geo.refresh();
    await geo.refresh();
    expect(geo.status().city?.databaseType).toBe("New-City");
    expect(geo.status().asn?.source).toBe("bundled");
    expect(logs.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain("private");
  } finally {
    logs.restore();
  }
});

test("two instances discover changes and resets only after the injected refresh interval", async () => {
  let now = 0;
  let sha256: string | undefined;
  let checks = 0;
  const source = {
    versions: async () => {
      checks++;
      return sha256 ? { city: sha256 } : {};
    },
    read: async () => mmdbFixture("city", { databaseType: "GeoLite2-City" }),
  };
  const files = paths();
  const first = createGeoIp({ paths: files, uploads: source, now: () => now });
  const second = createGeoIp({ paths: files, uploads: source, now: () => now });
  await first.refresh();
  await second.refresh();
  sha256 = "a".repeat(64);
  first.install("city", uploaded());
  now = 59_999;
  second.lookup("8.8.8.8");
  expect(checks).toBe(2);
  expect(second.status().city?.source).toBe("bundled");
  now++;
  second.lookup("8.8.8.8");
  await second.refresh();
  expect(second.status().city?.source).toBe("uploaded");
  sha256 = undefined;
  first.install("city", null);
  now += 60_000;
  second.lookup("8.8.8.8");
  await second.refresh();
  expect(second.status().city?.source).toBe("bundled");
  expect(checks).toBe(4);
});

test("failed version checks retry at a custom interval, including a synchronous source failure", async () => {
  let now = 100;
  let checks = 0;
  const geo = createGeoIp({
    paths: paths(),
    now: () => now,
    refreshIntervalMs: 50,
    uploads: {
      versions: () => {
        checks++;
        throw new Error("unavailable");
      },
      read: async () => null,
    },
  });
  geo.lookup("8.8.8.8");
  await geo.refresh();
  expect(checks).toBe(1);
  now += 49;
  geo.lookup("8.8.8.8");
  expect(checks).toBe(1);
  now++;
  geo.lookup("8.8.8.8");
  await geo.refresh();
  expect(checks).toBe(2);
  expect(geo.status().city?.source).toBe("bundled");
});

test("a vanished or invalid upload read keeps the installed version", async () => {
  for (const result of [null, new Uint8Array([1, 2, 3])]) {
    const geo = createGeoIp({
      paths: paths(),
      uploads: {
        versions: async () => ({ city: "a".repeat(64) }),
        read: async () => result,
      },
    });
    geo.install("city", uploaded("Current-City", "b".repeat(64)));
    await geo.refresh();
    expect(geo.status().city?.databaseType).toBe("Current-City");
  }
});

test("an unreadable stored upload is read once per version, and the other type still refreshes", async () => {
  let reads = 0;
  let citySha = "a".repeat(64);
  const geo = createGeoIp({
    paths: paths(),
    uploads: {
      versions: async () => ({ city: citySha, asn: "c".repeat(64) }),
      read: async (kind) => {
        reads++;
        return kind === "city" ? new Uint8Array([1, 2, 3]) : mmdbFixture("asn", { databaseType: "Uploaded-ASN" });
      },
    },
  });
  await geo.refresh();
  await geo.refresh();
  expect(reads).toBe(2);
  expect(geo.status().asn).toMatchObject({ databaseType: "Uploaded-ASN", source: "uploaded" });
  expect(geo.status().city?.source).toBe("bundled");
  citySha = "d".repeat(64);
  await geo.refresh();
  expect(reads).toBe(3);
});
