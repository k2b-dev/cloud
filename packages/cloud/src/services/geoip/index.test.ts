import { expect, spyOn, test } from "bun:test";
import { SQL, sql } from "bun";
import { Reader } from "mmdb-lib";
import { GEOIP_MAX_DATABASE_BYTES, GEOIP_MAX_REQUEST_BYTES } from "../../contracts/geoip";
import { createGeoIp, openGeoIpDatabase } from "../../server/request-context/geoip";
import { FIXTURE_EPOCH, mmdbFixture } from "../../server/request-context/geoip.test-fixture";
import { audit } from "../audit";
import { createGeoIpService, type GeoIpUploadInfo, geoIpAdminStatus } from ".";
import { parseGeoIpUpload, readGeoIpUpload } from "./upload";

const buildDate = new Date(FIXTURE_EPOCH * 1000);
const bundled = { city: openGeoIpDatabase("city", mmdbFixture("city"))!.info, asn: null };
const row = (databaseType: string, description = "Synthetic"): GeoIpUploadInfo => ({
  kind: "city",
  sha256: "a".repeat(64),
  size: 123,
  database_type: databaseType,
  build_epoch: buildDate,
  description,
  uploaded_at: buildDate,
  uploaded_by: null,
  uploader_name: null,
});

test("staleness uses the build date and the injected clock; empty types have no source", () => {
  expect(geoIpAdminStatus([], bundled, Date.UTC(2027, 2, 1)).databases[0].stale).toBe(false);
  expect(geoIpAdminStatus([], bundled, Date.UTC(2027, 4, 1)).databases[0].stale).toBe(true);
  expect(geoIpAdminStatus([], bundled, buildDate.getTime() + 183 * 86400000).databases[0].stale).toBe(false);
  expect(geoIpAdminStatus([], bundled, buildDate.getTime()).databases[0]).toMatchObject({ source: "bundled", bundled: true });
  expect(geoIpAdminStatus([], bundled, buildDate.getTime()).databases[1]).toMatchObject({
    source: null,
    bundled: false,
    stale: false,
    dbIp: false,
    upload: null,
  });
});

test("attribution follows active DB-IP data, including an uploaded description", () => {
  expect(geoIpAdminStatus([], bundled, 0).attribution?.text).toBe("IP Geolocation by DB-IP");
  const maxmind = geoIpAdminStatus([row("GeoLite2-City")], bundled, 0);
  expect(maxmind.attribution).toBeNull();
  expect(maxmind.databases[0]).toMatchObject({ source: "uploaded", bundled: true, dbIp: false, upload: { sha256: "a".repeat(64) } });
  for (const upload of [row("DBIP-City-Lite"), row("Custom-City", "IP Geolocation by DB-IP")])
    expect(geoIpAdminStatus([upload], bundled, 0).attribution).not.toBeNull();
});

test("the service denies every non-admin call before reading or querying", async () => {
  const service = createGeoIpService();
  const actor = { id: "not-used", roles: ["user"] };
  await expect(service.status(actor)).rejects.toMatchObject({ status: 403 });
  await expect(service.reset(actor, "city")).rejects.toMatchObject({ status: 403 });
  await expect(service.upload(actor, new ReadableStream(), {})).rejects.toMatchObject({ status: 403 });
});

test("raw and gzip uploads are detected by magic bytes, including split magic", async () => {
  const fixture = mmdbFixture("city");
  expect(await readGeoIpUpload(new Blob([fixture]).stream())).toEqual(fixture);
  const compressed = Bun.gzipSync(fixture);
  const chunks = [compressed.subarray(0, 1), compressed.subarray(1, 2), compressed.subarray(2)];
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next) controller.enqueue(next);
      else controller.close();
    },
  });
  expect(await readGeoIpUpload(body)).toEqual(fixture);
});

test("a declared oversized request is rejected before reading the body", async () => {
  let reads = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        reads++;
      },
    },
    { highWaterMark: 0 },
  );
  await expect(readGeoIpUpload(body, GEOIP_MAX_REQUEST_BYTES + 1)).rejects.toMatchObject({ code: "geoip_request_too_large" });
  expect(reads).toBe(0);
});

test("raw streams stop at the request bound and cancel without consuming the rest", async () => {
  let sent = 0;
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        sent++;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  await expect(readGeoIpUpload(body)).rejects.toMatchObject({ code: "geoip_request_too_large" });
  expect(sent).toBeLessThanOrEqual(GEOIP_MAX_REQUEST_BYTES / chunk.length + 2);
  expect(cancelled).toBe(true);
});

test("gzip bombs stop at the unpacked bound and cancel their source", async () => {
  let sent = 0;
  let onCancel!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    onCancel = resolve;
  });
  const chunk = new Uint8Array(1024 * 1024);
  const generated = new ReadableStream<Uint8Array<ArrayBuffer>>(
    {
      async pull(controller) {
        // Yield to keep the producer behind the bounded decompressor.
        await Bun.sleep(1);
        sent++;
        controller.enqueue(chunk);
      },
      cancel() {
        onCancel();
      },
    },
    { highWaterMark: 0 },
  );
  await expect(readGeoIpUpload(generated.pipeThrough(new CompressionStream("gzip")))).rejects.toMatchObject({ code: "geoip_too_large" });
  await cancelled;
  expect(sent).toBeLessThan((2 * GEOIP_MAX_DATABASE_BYTES) / chunk.length);
}, 30_000);

test("empty, corrupt gzip and invalid MMDB fail with stable codes", async () => {
  for (const bytes of [new Uint8Array(), Bun.gzipSync(new Uint8Array())])
    await expect(readGeoIpUpload(new Blob([bytes]).stream())).rejects.toMatchObject({ code: "geoip_empty" });
  await expect(readGeoIpUpload(new Blob([new Uint8Array([0x1f, 0x8b, 0])]).stream())).rejects.toMatchObject({ code: "geoip_invalid" });
  expect(() => parseGeoIpUpload(new Uint8Array([1, 2, 3]))).toThrow();
  try {
    parseGeoIpUpload(new Uint8Array([1, 2, 3]));
  } catch (error) {
    expect(error).toMatchObject({ code: "geoip_invalid" });
  }
});

test("metadata determines the kind; IPv4 trees and unsupported types are rejected", () => {
  for (const kind of ["city", "asn"] as const) {
    const parsed = parseGeoIpUpload(mmdbFixture(kind));
    expect(parsed.kind).toBe(kind);
    expect(parsed.metadata.buildEpoch).toBe("2026-10-01T00:00:00.000Z");
    expect(parsed.metadata.description.en).toBe("Synthetic test database");
  }
  for (const [bytes, code] of [
    [mmdbFixture("city", { ipVersion: 4 }), "geoip_invalid"],
    [mmdbFixture("city", { buildEpoch: "invalid" }), "geoip_invalid"],
    [mmdbFixture("city", { description: "invalid\0text" }), "geoip_invalid"],
    [mmdbFixture("city", { databaseType: "Country" }), "geoip_unsupported_type"],
    [mmdbFixture("city", { databaseType: "x".repeat(128) + "City" }), "geoip_invalid"],
  ] as const) {
    try {
      parseGeoIpUpload(bytes);
      throw new Error("accepted");
    } catch (error) {
      expect(error).toMatchObject({ code });
    }
  }
  expect(
    Buffer.byteLength(parseGeoIpUpload(mmdbFixture("city", { description: "界".repeat(200) })).metadata.description.en),
  ).toBeLessThanOrEqual(256);
});

test("readable metadata cannot hide corrupt or non-object records", () => {
  expect(() => parseGeoIpUpload(mmdbFixture("city", { corruptData: true }))).toThrow(expect.objectContaining({ code: "geoip_invalid" }));
  // Replace the first data map with a valid MMDB string, number or array.
  for (const header of [[0x40], [0xc0], [0x00, 0x04]]) {
    const bytes = mmdbFixture("city");
    const dataOffset = new Reader(bytes).metadata.searchTreeSize + 16;
    bytes.set(header, dataOffset);
    expect(() => parseGeoIpUpload(bytes)).toThrow(expect.objectContaining({ code: "geoip_invalid" }));
  }
});

test.each(["oops", 0, 1_000_000])("invalid node_count %s cannot replace a working database", (nodeCount) => {
  const bytes = mmdbFixture("city", { nodeCount });
  expect(() => parseGeoIpUpload(bytes)).toThrow(expect.objectContaining({ code: "geoip_invalid" }));
  expect(openGeoIpDatabase("city", bytes)).toBeNull();
});

test("a normal fixture still opens with valid structural metadata", () => {
  expect(openGeoIpDatabase("city", mmdbFixture("city"))).not.toBeNull();
});

test("an already cancelled upload never starts an INSERT transaction or installs a reader", async () => {
  const reader = createGeoIp();
  const install = spyOn(reader, "install");
  const begin = spyOn(sql, "begin").mockRejectedValue(new Error("Unexpected transaction"));
  const controller = new AbortController();
  controller.abort();
  try {
    const service = createGeoIpService({ reader });
    await expect(
      service.upload({ id: "unused", roles: ["admin"] }, new Blob([mmdbFixture("city")]).stream(), { signal: controller.signal }),
    ).rejects.toBe(controller.signal.reason);
    expect(begin).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  } finally {
    begin.mockRestore();
    install.mockRestore();
  }
});

test("cancellation during the audit rejects the transaction without installing the reader", async () => {
  const controller = new AbortController();
  const aborted = new DOMException("Upload cancelled", "AbortError");
  const reader = createGeoIp();
  const install = spyOn(reader, "install").mockImplementation(() => {
    throw new Error("Unexpected reader installation");
  });
  const client = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  let inserts = 0;
  let committed = false;
  const tx = new Proxy(client, {
    apply: (_target, _this, args) => {
      expect(String(args[0])).toContain("INSERT INTO geoip.databases");
      inserts++;
      return Promise.resolve([]);
    },
  });
  const begin = spyOn(client, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    const result = await run(tx);
    committed = true;
    return result;
  });
  const record = spyOn(audit, "record").mockImplementation(async (_params, db) => {
    expect(db).toBe(tx);
    controller.abort(aborted);
  });
  try {
    const service = createGeoIpService({ db: client, reader });
    await expect(
      service.upload({ id: "unused", roles: ["admin"] }, new Blob([mmdbFixture("city")]).stream(), { signal: controller.signal }),
    ).rejects.toBe(aborted);
    expect(inserts).toBe(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(committed).toBe(false);
    expect(install).not.toHaveBeenCalled();
  } finally {
    for (const spy of [begin, record, install]) spy.mockRestore();
    await client.close();
  }
});

test("valid uploads use a fixed, bounded probe across IPv4 and IPv6", () => {
  const get = spyOn(Reader.prototype, "get");
  try {
    expect(parseGeoIpUpload(mmdbFixture("city")).kind).toBe("city");
    expect(get).toHaveBeenCalledTimes(1030);
    for (const address of ["0.0.0.0", "255.128.0.0", "2000::", "3ff0::", "8.8.8.8", "2001:4860:4860::8888"])
      expect(get).toHaveBeenCalledWith(address);
  } finally {
    get.mockRestore();
  }
});

test("shared pointer containers stay bounded during upload probes and lookups", () => {
  const bytes = mmdbFixture("city", { repeatedPointerDepth: 22 });
  const started = performance.now();
  const parsed = parseGeoIpUpload(bytes);
  const probeMs = performance.now() - started;
  console.info(`Repeated-pointer upload probe: ${probeMs.toFixed(2)} ms`);
  expect(parsed.kind).toBe("city");

  const database = openGeoIpDatabase("city", bytes)!;
  const lookupStarted = performance.now();
  const result = database.get("8.8.8.8");
  const lookupMs = performance.now() - lookupStarted;
  console.info(`Repeated-pointer lookup: ${lookupMs.toFixed(2)} ms`);
  expect(probeMs).toBeLessThan(500);
  expect(lookupMs).toBeLessThan(500);
  expect(result).not.toBeNull();
  let shared: unknown = result && "shared" in result ? result.shared : null;
  for (let depth = 0; depth < 22; depth++) {
    if (!Array.isArray(shared)) throw new Error("Expected a shared pointer array");
    expect(shared).toHaveLength(2);
    expect(shared[0]).toBe(shared[1]);
    shared = shared[0];
  }
  expect(shared).toBe("leaf");
  // A fresh object proves the decoder cache does not retain results between lookups.
  expect(database.get("8.8.8.8")).not.toBe(result);
});

test("an upload probe keeps no decoded record from one address to the next", () => {
  // Distinct large records would otherwise add up in memory across the 1,030 probe addresses.
  const bytes = mmdbFixture("city", { sharedRecordEntries: 3_074 });
  const get = spyOn(Reader.prototype, "get");
  try {
    const started = performance.now();
    expect(parseGeoIpUpload(bytes).kind).toBe("city");
    console.info(`Upload probe with a record near the work cap: ${(performance.now() - started).toFixed(2)} ms`);
    // The first two probe addresses share a record, and each lookup decodes it afresh.
    expect(get.mock.results[0]?.value).toMatchObject({ city: { names: { en: "Vienna" } } });
    expect(get.mock.results[1]?.value).toEqual(get.mock.results[0]?.value);
    expect(get.mock.results[1]?.value).not.toBe(get.mock.results[0]?.value);
  } finally {
    get.mockRestore();
  }
});

test("an upload probe refuses a record above the per-lookup work cap", () => {
  const bytes = mmdbFixture("city", { sharedRecordEntries: 20_000 });
  // The record is valid MMDB data; only the per-lookup work cap refuses it.
  expect(() => parseGeoIpUpload(bytes)).toThrow(expect.objectContaining({ code: "geoip_invalid" }));
});

test("shared arrays used as map keys are rejected before decoder coercion", () => {
  const bytes = mmdbFixture("city", { mapKeyPointerDepth: 24 });
  const started = performance.now();
  expect(() => parseGeoIpUpload(bytes)).toThrow(expect.objectContaining({ code: "geoip_invalid" }));
  expect(performance.now() - started).toBeLessThan(500);
  const database = openGeoIpDatabase("city", bytes)!;
  expect(database).not.toBeNull();
  for (let attempt = 0; attempt < 2; attempt++) {
    const lookupStarted = performance.now();
    expect(() => database.get("8.8.8.8")).toThrow();
    expect(performance.now() - lookupStarted).toBeLessThan(500);
  }
});

test("a container already checked as a value cannot be reused as a map key", () => {
  const bytes = mmdbFixture("city", { repeatedPointerDepth: 1 });
  const dataStart = new Reader(bytes).metadata.searchTreeSize + 16;
  // The shared array follows the five-byte leaf string and takes twelve bytes.
  bytes.set([0xe2, 0x40, 0x38, 0, 0, 0, 5, 0x38, 0, 0, 0, 5, 0x40], dataStart + 17);
  expect(() => parseGeoIpUpload(bytes)).toThrow(expect.objectContaining({ code: "geoip_invalid" }));
  expect(() => openGeoIpDatabase("city", bytes)!.get("8.8.8.8")).toThrow();
});

test("data pointers cannot escape into the metadata marker or section", () => {
  for (const sectionOffset of [0, 14]) {
    const bytes = mmdbFixture("city");
    const dataStart = new Reader(bytes).metadata.searchTreeSize + 16;
    const marker = bytes.indexOf(Buffer.from("abcdef4d61784d696e642e636f6d", "hex"));
    bytes[dataStart] = 0x38;
    bytes.writeUInt32BE(marker + sectionOffset - dataStart, dataStart + 1);
    expect(() => openGeoIpDatabase("city", bytes)!.get("8.8.8.8")).toThrow();
  }
});

test("map keys can point to a shared string", () => {
  const bytes = mmdbFixture("city", { mapKeyPointerDepth: 0 });
  expect(parseGeoIpUpload(bytes).kind).toBe("city");
  const database = openGeoIpDatabase("city", bytes)!;
  expect(database.get("8.8.8.8")).toMatchObject({ leaf: "shared value" });
  expect(database.get("2a01:4f8::1")).toMatchObject({ leaf: "shared value" });
});

test("metadata pointer expansion is rejected before upload parsing or opening a stored database", () => {
  const bytes = mmdbFixture("city", { metadataPointerDepth: 24 });
  const started = performance.now();
  expect(() => parseGeoIpUpload(bytes)).toThrow(expect.objectContaining({ code: "geoip_invalid" }));
  expect(performance.now() - started).toBeLessThan(500);
  const openStarted = performance.now();
  expect(openGeoIpDatabase("city", bytes)).toBeNull();
  expect(performance.now() - openStarted).toBeLessThan(500);
});

test("legitimate metadata pointers preserve the uploaded description", () => {
  const bytes = mmdbFixture("city", { metadataDescriptionPointer: true, description: "Shared description" });
  expect(parseGeoIpUpload(bytes).metadata.description.en).toBe("Shared description");
  expect(openGeoIpDatabase("city", bytes)).not.toBeNull();
});

test("truncated metadata and a marker outside the final 128 KiB are rejected", () => {
  const bytes = mmdbFixture("city");
  for (const invalid of [bytes.subarray(0, bytes.length - 1), Buffer.concat([bytes, Buffer.alloc(128 * 1024)])]) {
    expect(() => parseGeoIpUpload(invalid)).toThrow(expect.objectContaining({ code: "geoip_invalid" }));
    expect(openGeoIpDatabase("city", invalid)).toBeNull();
  }
});

test("a concurrent upload fails immediately and the flag clears after failure", async () => {
  const service = createGeoIpService();
  const actor = { id: "unused", roles: ["admin"] };
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const pending = service.upload(
    actor,
    new ReadableStream({
      start(value) {
        controller = value;
      },
    }),
    {},
  );
  await expect(service.upload(actor, new ReadableStream(), {})).rejects.toMatchObject({ code: "geoip_upload_busy" });
  controller.close();
  await expect(pending).rejects.toMatchObject({ code: "geoip_empty" });
  await expect(service.upload(actor, new Blob([]).stream(), {})).rejects.toMatchObject({ code: "geoip_empty" });
});

test("a database without the optional language list is accepted with an empty list", () => {
  const parsed = parseGeoIpUpload(mmdbFixture("asn", { languages: null, databaseType: "GeoLite2-ASN" }));
  expect(parsed.kind).toBe("asn");
  expect(parsed.metadata.languages).toEqual([]);
});

test("stored metadata caps language count and UTF-8 size before reaching Postgres", () => {
  const result = parseGeoIpUpload(mmdbFixture("city", { languages: Array(100).fill("界".repeat(100)) }));
  expect(result.metadata.languages).toHaveLength(16);
  expect(result.metadata.languages.every((language) => Buffer.byteLength(language) <= 32)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.metadata, null, 1))).toBeLessThanOrEqual(4096);
});
