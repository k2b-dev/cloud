import { expect, test } from "bun:test";
import { sql } from "bun";
import { tinyJpeg, withCameraMetadata } from "../../../../../scripts/fixtures/image-metadata";
import { databaseSuite } from "../../../../../scripts/fixtures/test-infra";
import { decryptValue } from "./crypto";
import { registerSettings } from "./defaults";
import * as settings from "./index";

/**
 * Deliberately never touches a real setting.
 *
 * Writing shared settings from a test wipes the developer's configuration — it
 * has happened twice, which is why `ai/settings-guard.test.ts` exists. The probe
 * keys below are registered in-process only, unique per run, and removed at the
 * end, so no key any app reads is involved.
 */

/** Reported as skipped rather than silently passing when the backing service is absent. */
const suite = databaseSuite();

const probeKey = () => `test.transaction_probe_${crypto.randomUUID().replaceAll("-", "")}`;

const rowFor = async (key: string) => {
  const [row] = await sql<{ key: string }[]>`SELECT key FROM settings.entries WHERE key = ${key}`;
  return row ?? null;
};

suite("settings writes inside a caller's transaction", () => {
  test("inline image settings lose metadata before encryption; invalid containers cannot be written", async () => {
    const key = probeKey();
    registerSettings([{ key, kind: "image", default: "", label: "Photo probe", description: "Test only.", group: "test" }]);
    try {
      const jpeg = await tinyJpeg();
      const dataUrl = (bytes: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
      await sql.begin((tx) => settings.set(key, dataUrl(withCameraMetadata(jpeg, 1)), tx));
      const [row] = await sql<{ value: string }[]>`SELECT value FROM settings.entries WHERE key=${key}`;
      expect(await decryptValue(row!.value)).toBe(dataUrl(jpeg));
      await expect(sql.begin((tx) => settings.set(key, dataUrl(new Uint8Array([255, 216, 255, 219, 0])), tx))).rejects.toMatchObject({
        status: 422,
      });
    } finally {
      await sql`DELETE FROM settings.entries WHERE key=${key}`;
    }
  });

  test("a later failure rolls the earlier write back", async () => {
    const key = probeKey();
    registerSettings([{ key, kind: "string", default: "", label: "Transaction probe", description: "Test only.", group: "test" }]);

    try {
      await expect(
        sql.begin(async (tx) => {
          await settings.set(key, "written", tx);
          // Unknown keys throw before touching the database, which is the
          // cheapest way to fail *after* the first write has already run.
          await settings.set("definitely.not.a.registered.setting", "x", tx);
        }),
      ).rejects.toThrow();

      // The whole point: before threading the transaction through, the first
      // write ran on its own pooled connection and survived this rollback.
      expect(await rowFor(key)).toBeNull();
    } finally {
      await sql`DELETE FROM settings.entries WHERE key = ${key}`;
    }
  });

  test("a transaction that commits keeps every write", async () => {
    const first = probeKey();
    const second = probeKey();
    for (const key of [first, second]) {
      registerSettings([{ key, kind: "string", default: "", label: "Transaction probe", description: "Test only.", group: "test" }]);
    }

    try {
      await sql.begin(async (tx) => {
        await settings.set(first, "one", tx);
        await settings.set(second, "two", tx);
      });

      expect(await rowFor(first)).not.toBeNull();
      expect(await rowFor(second)).not.toBeNull();
    } finally {
      await sql`DELETE FROM settings.entries WHERE key = ${first} OR key = ${second}`;
    }
  });
});
