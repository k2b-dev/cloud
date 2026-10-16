import { describe, expect, test } from "bun:test";
import {
  buildNotebookBackupPaths,
  checkSnapshotTarget,
  createNotebookBackupManifest,
  describeSnapshotError,
  type NotebookBackupConfig,
  type NotebookBackupObject,
  snapshotAllowlist,
  validateSnapshotEndpoint,
} from "./backup";
import type { NotebookExport } from "./export";

const config: NotebookBackupConfig = {
  enabled: true,
  endpoint: "https://s3.example.org",
  region: "eu-central-1",
  bucket: "cloud-backups",
  prefix: "notebooks",
  accessKeyId: "key",
  secretAccessKey: "secret",
  missing: [],
  configured: true,
};

const exported: NotebookExport = {
  filename: "daily-journal-2026-05-28.zip",
  notebook: {
    id: "nb1234",
    name: "Daily Journal",
  },
  files: [],
  zip: new Uint8Array([1, 2, 3, 4]),
};

describe("notebook S3 backup", () => {
  test("builds deterministic latest, snapshot, and manifest object keys", () => {
    const paths = buildNotebookBackupPaths(config, {
      notebookShortId: "nb1234",
      exportedAt: new Date("2026-05-28T14:30:05.123Z"),
    });

    expect(paths).toEqual({
      latestZip: "notebooks/nb1234/latest.zip",
      snapshotZip: "notebooks/nb1234/snapshots/2026-05-28T14-30-05-123Z.zip",
      manifest: "notebooks/nb1234/latest-manifest.json",
    });
  });

  test("creates a manifest from the portable export metadata", () => {
    const paths = buildNotebookBackupPaths(config, {
      notebookShortId: exported.notebook.id,
      exportedAt: new Date("2026-05-28T14:30:05.123Z"),
    });

    const manifest = createNotebookBackupManifest({
      exported,
      exportedAt: new Date("2026-05-28T14:30:05.123Z"),
      paths,
    });

    expect(manifest).toMatchObject({
      format: "stuve.notebook.backup",
      version: 1,
      exportedAt: "2026-05-28T14:30:05.123Z",
      notebook: exported.notebook,
      filename: exported.filename,
      zipBytes: 4,
      paths,
    });
    expect(manifest.notebook).toEqual({ id: "nb1234", name: "Daily Journal" });
    expect(manifest.notebook).not.toHaveProperty("shortId");
    expect(manifest.sha256).toHaveLength(64);
  });

  test("backup objects stay simple enough for uploader tests", () => {
    const object: NotebookBackupObject = {
      path: "notebooks/nb1234/latest.zip",
      contentType: "application/zip",
      content: exported.zip,
    };

    expect(object.content).toBe(exported.zip);
  });

  test("normalizes empty provider errors into actionable text", () => {
    expect(describeSnapshotError(new Error(""))).toBe("Provider returned no error details.");
    expect(describeSnapshotError(Object.assign(new Error(""), { name: "S3Error" }), "Check settings.")).toBe("Check settings.");
    expect(describeSnapshotError({ code: "AccessDenied" })).toBe('{"code":"AccessDenied"}');
  });

  test("summarizes HTML provider errors instead of returning whole pages", () => {
    const error = Object.assign(new Error("<html><head><title>403 - Forbidden</title></head><body>Status Code 403</body></html>"), {
      name: "S3Error",
    });

    expect(describeSnapshotError(error)).toBe("HTTP 403 403 - Forbidden (S3Error)");
  });

  test("rejects Hetzner endpoints without location subdomain", () => {
    const invalid = validateSnapshotEndpoint("https://your-objectstorage.com", "nbg1");
    const valid = validateSnapshotEndpoint("https://nbg1.your-objectstorage.com", "nbg1");

    expect(invalid.ok).toBe(false);
    expect(valid.ok).toBe(true);
    if (!invalid.ok) expect(invalid.error.message).toContain("https://nbg1.your-objectstorage.com");
  });

  test("rejects non-HTTP S3 endpoints", () => {
    const result = validateSnapshotEndpoint("file:///tmp/notebooks", "local");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("http or https");
  });
});

test("snapshot save checks refuse known internal targets with a stable code", async () => {
  const { NetworkTargetBlockedError } = await import("@k2b/cloud/services/network-security");
  expect(
    await checkSnapshotTarget(config, {
      resolve: async () => {
        throw new NetworkTargetBlockedError("Blocked");
      },
    }),
  ).toMatchObject({ ok: false, error: { code: "NOTEBOOK_SNAPSHOT_TARGET_BLOCKED", status: 400 } });
  expect(
    (
      await checkSnapshotTarget(config, {
        resolve: async () => {
          throw new Error("Lookup failed");
        },
      })
    ).ok,
  ).toBe(true);
  expect((await checkSnapshotTarget(config, { resolve: () => new Promise(() => {}), timeoutMs: 1 })).ok).toBe(true);
  let checked = false;
  expect(
    (
      await checkSnapshotTarget(
        { ...config, enabled: false },
        {
          resolve: async () => {
            checked = true;
            throw new Error("Must not check");
          },
        },
      )
    ).ok,
  ).toBe(true);
  expect(checked).toBe(false);
});

test("snapshot allowlist validates operator configuration with its variable name", () => {
  const original = process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS;
  try {
    process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS = "0.0.0.0/0";
    expect(snapshotAllowlist).toThrow("NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS: Invalid network allowlist entry");
  } finally {
    if (original === undefined) delete process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS;
    else process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS = original;
  }
});

test("save checks use the signed URL hostname, including the default AWS region", async () => {
  const hosts: string[] = [];
  const resolve = async (hostname: string) => {
    hosts.push(hostname);
    return [];
  };
  expect((await checkSnapshotTarget({ ...config, endpoint: "", region: "eu-central-1" }, { resolve })).ok).toBe(true);
  expect((await checkSnapshotTarget({ ...config, endpoint: "https://snapshots.test:9000" }, { resolve })).ok).toBe(true);
  expect(hosts).toEqual(["s3.eu-central-1.amazonaws.com", "snapshots.test"]);
  expect(await checkSnapshotTarget({ ...config, endpoint: "", region: "a/b" }, { resolve })).toMatchObject({
    ok: false,
    error: { status: 400 },
  });
});
