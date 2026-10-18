import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBIP_ATTRIBUTION, type GeoIpAdminStatus } from "../../contracts/geoip";
import { mmdbFixture } from "../../server/request-context/geoip.test-fixture";
import type { CloudCliContext, CloudCliFlags, CloudCliOutputMode } from "../index";
import admin from ".";

const status: GeoIpAdminStatus = {
  databases: [
    {
      kind: "city",
      source: "bundled",
      bundled: true,
      databaseType: "DBIP-City-Lite",
      buildDate: "2026-10-01T00:00:00.000Z",
      stale: false,
      dbIp: true,
      upload: null,
    },
    { kind: "asn", source: null, bundled: false, databaseType: null, buildDate: null, stale: false, dbIp: false, upload: null },
  ],
  attribution: DBIP_ATTRIBUTION,
  limits: { maxDatabaseBytes: 201326592, maxRequestBytes: 134217728 },
};
const fixture = (args: string[], flags: CloudCliFlags = {}, output: CloudCliOutputMode = "text", locale = "en") => {
  const calls: { path: string; init?: RequestInit }[] = [];
  const lines: string[] = [];
  const tables: unknown[] = [];
  let receive = async (_init?: RequestInit) => Response.json(status);
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "https://cloud.test", token: "test", output, locale },
    getDefault: async () => undefined,
    setDefault: async () => {},
    createApiClient: () => {
      throw new Error("unused");
    },
    fetch: async (path, init) => {
      calls.push({ path, init });
      return receive(init);
    },
    readJson: async (response) => {
      if (!response.ok) throw new Error(response.statusText);
      return response.json();
    },
    print: (value = "") => {
      lines.push(value);
    },
    write: async (value) => {
      lines.push(value);
    },
    error: (value) => {
      lines.push(value);
    },
    json: (value) => {
      lines.push(JSON.stringify(value, null, 2));
    },
    jsonLine: (value) => {
      lines.push(JSON.stringify(value));
    },
    table: (rows) => {
      tables.push(rows);
    },
  };
  return {
    ctx,
    calls,
    lines,
    tables,
    receive: (fn: typeof receive) => {
      receive = fn;
    },
  };
};
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const file = async (bytes: Uint8Array) => {
  const dir = await mkdtemp(join(tmpdir(), "geoip-cli-"));
  dirs.push(dir);
  const path = join(dir, "database");
  await Bun.write(path, bytes);
  return path;
};

test("status displays both types and attribution, with valid JSON and JSONL output", async () => {
  const text = fixture(["geoip", "status"]);
  await admin.run(text.ctx);
  expect(text.calls[0]?.path).toBe("/api/admin/core/geoip");
  expect(text.tables[0]).toMatchObject([
    { type: "city", source: "bundled", built: "2026-10-01T00:00:00.000Z" },
    { type: "asn", source: "-" },
  ]);
  expect(text.lines[0]).toContain("IP Geolocation by DB-IP");
  for (const mode of ["json", "jsonl"] as const) {
    const result = fixture(["geoip", "status"], {}, mode);
    await admin.run(result.ctx);
    expect(result.lines).toHaveLength(1);
    expect(JSON.parse(result.lines[0]!)).toEqual(status);
    if (mode === "jsonl") expect(result.lines[0]).not.toContain("\n");
  }
});

test("upload uses a streaming gzip body and duplex half for raw and already compressed files", async () => {
  const bytes = mmdbFixture("city");
  for (const gzip of [false, true]) {
    const stored = gzip ? Bun.gzipSync(bytes) : bytes;
    const test = fixture(["geoip", "upload", await file(stored)]);
    let received: Uint8Array<ArrayBuffer> | undefined;
    test.receive(async (init) => {
      if (!init) return Response.json(status);
      expect(init?.body).toBeInstanceOf(ReadableStream);
      expect(init).toMatchObject({ method: "PUT", duplex: "half", headers: { "Content-Type": "application/gzip" } });
      received = new Uint8Array(await new Response(init?.body).arrayBuffer());
      return Response.json(status);
    });
    await admin.run(test.ctx);
    expect(received?.subarray(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
    expect(Bun.gunzipSync(received!)).toEqual(bytes);
    if (gzip) expect(received).toEqual(stored);
    expect(test.calls.map((call) => call.init?.method ?? "GET")).toEqual(["GET", "PUT"]);
  }
});

test("reset requires yes, accepts a single type, defaults to both, and rejects unknown types", async () => {
  const refused = fixture(["geoip", "reset"]);
  await expect(admin.run(refused.ctx)).rejects.toThrow("--yes");
  expect(refused.calls).toHaveLength(0);
  for (const kind of ["city", "asn", undefined]) {
    const test = fixture(["geoip", "reset", ...(kind ? [kind] : [])], { yes: true });
    await admin.run(test.ctx);
    expect(test.calls.map((call) => call.path)).toEqual((kind ? [kind] : ["city", "asn"]).map((value) => `/api/admin/core/geoip/${value}`));
    expect(test.calls.every((call) => call.init?.method === "DELETE")).toBe(true);
  }
  const wrong = fixture(["geoip", "reset", "country"], { yes: true });
  await expect(admin.run(wrong.ctx)).rejects.toThrow("city or asn");
  expect(wrong.calls).toHaveLength(0);
});

test("API codes become clear English and German CLI errors", async () => {
  for (const [code, en, de] of [
    ["geoip_too_large", "192 MiB", "192 MiB"],
    ["geoip_empty", "empty", "leer"],
    ["geoip_invalid", "IPv6", "IPv6"],
    ["geoip_unsupported_type", "City and ASN", "City- und ASN"],
    ["geoip_upload_busy", "Another upload", "anderer Upload"],
  ]) {
    for (const [locale, message] of [
      ["en", en],
      ["de", de],
    ]) {
      const test = fixture(["geoip", "status"], {}, "text", locale);
      test.receive(async () => Response.json({ code }, { status: 422 }));
      await expect(admin.run(test.ctx)).rejects.toThrow(message);
    }
  }
});

test("the command group is discoverable in admin help", () => {
  expect(admin.help?.()).toContain("geoip");
});

test("resetting both types reports a change when only the first type had an upload", async () => {
  const result = fixture(["geoip", "reset"], { yes: true }, "json");
  let calls = 0;
  result.receive(async () => Response.json({ ...status, changed: calls++ === 0 }));
  await admin.run(result.ctx);
  expect(JSON.parse(result.lines[0]!).changed).toBe(true);
});
