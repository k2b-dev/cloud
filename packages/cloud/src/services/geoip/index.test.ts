import { expect, test } from "bun:test";
import { GEOIP_MAX_DATABASE_BYTES, GEOIP_MAX_REQUEST_BYTES } from "../../contracts/geoip";
import { openGeoIpDatabase } from "../../server/request-context/geoip";
import { FIXTURE_EPOCH, mmdbFixture } from "../../server/request-context/geoip.test-fixture";
import { createGeoIpService, geoIpAdminStatus, type GeoIpUploadInfo } from ".";
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
  await expect(readGeoIpUpload(body, GEOIP_MAX_REQUEST_BYTES + 1)).rejects.toMatchObject({ code: "geoip_too_large" });
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
  await expect(readGeoIpUpload(body)).rejects.toMatchObject({ code: "geoip_too_large" });
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

test("stored metadata caps language count and UTF-8 size before reaching Postgres", () => {
  const result = parseGeoIpUpload(mmdbFixture("city", { languages: Array(100).fill("界".repeat(100)) }));
  expect(result.metadata.languages).toHaveLength(16);
  expect(result.metadata.languages.every((language) => Buffer.byteLength(language) <= 32)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.metadata, null, 1))).toBeLessThanOrEqual(4096);
});
