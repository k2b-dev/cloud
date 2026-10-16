import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { afterEach, expect, test } from "bun:test";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { encryptValue } from "@k2b/cloud/services/settings/crypto";
import { sql } from "bun";
import api from "../api";
import { listLogs, runNotebookS3Backup, snapshotTargetBlocked, updateConfig } from "./backup";
import { notebookServiceMessages } from "./messages";

const suite = databaseSuite();
const original = process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS;
afterEach(() => {
  if (original === undefined) delete process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS;
  else process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS = original;
});

suite("Notebook snapshot target policy", () => {
  test("refuses saves without storing, accepts operator exceptions, and logs existing internal targets in English", async () => {
    delete process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS;
    const id = crypto.randomUUID();
    const uid = `snapshot-${crypto.randomUUID()}`;
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users (uid, provider, profile) VALUES (${uid}, 'local', 'user') RETURNING id`;
    const userId = user!.id;
    const shortId = id.replaceAll("-", "").slice(0, 6);
    let accountId: string | undefined;
    let accessId: string | undefined;
    await sql`INSERT INTO notebooks.notebooks (id, short_id, name) VALUES (${id}::uuid, ${shortId}, 'Snapshot policy test')`;
    const data = {
      enabled: true,
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      bucket: "bucket",
      accessKeyId: "test-key",
      secretAccessKey: "test-secret",
    };
    try {
      expect(await updateConfig({ notebookId: id, userId, data })).toMatchObject({ ok: false, error: snapshotTargetBlocked() });
      expect(await sql`SELECT notebook_id FROM notebooks.s3_snapshot_configs WHERE notebook_id = ${id}::uuid`).toHaveLength(0);
      process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS = "127.0.0.1";
      expect((await updateConfig({ notebookId: id, userId, data })).ok).toBe(true);
      await sql`DELETE FROM notebooks.s3_snapshot_configs WHERE notebook_id = ${id}::uuid`;
      delete process.env.NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS;
      const key = await encryptValue(data.accessKeyId);
      const secret = await encryptValue(data.secretAccessKey);
      await sql`INSERT INTO notebooks.s3_snapshot_configs (notebook_id, enabled, endpoint, region, bucket, access_key_id, secret_access_key, updated_by)
        VALUES (${id}::uuid, true, ${data.endpoint}, ${data.region}, ${data.bucket}, ${key}, ${secret}, ${userId}::uuid)`;
      for (const trigger of ["manual", "scheduler"] as const) {
        expect(await runNotebookS3Backup({ notebookId: id, trigger, exportedAt: new Date("2026-05-28T14:30:05.123Z") })).toMatchObject({
          ok: false,
          error: snapshotTargetBlocked(),
        });
      }
      const logs = await listLogs({ notebookId: id });
      expect(logs).toHaveLength(2);
      for (const entry of logs) {
        expect(entry).toMatchObject({
          level: "error",
          message: "Notebook S3 snapshot upload failed",
          metadata: { error: snapshotTargetBlocked().message },
        });
      }
      expect(await sql`SELECT notebook_id FROM notebooks.s3_snapshot_configs WHERE notebook_id = ${id}::uuid`).toHaveLength(1);

      const [account] = await sql<{ id: string }[]>`INSERT INTO auth.service_accounts (name, kind, delegated_user_id)
        VALUES (${uid}, 'user_delegated', ${userId}::uuid) RETURNING id`;
      accountId = account!.id;
      const [access] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access (user_id, permission) VALUES (${userId}::uuid, 'admin') RETURNING id`;
      accessId = access!.id;
      await sql`INSERT INTO notebooks.notebook_access (notebook_id, access_id) VALUES (${id}::uuid, ${accessId}::uuid)`;
      const credential = await serviceAccountCredentials.createApiToken({
        serviceAccountId: accountId,
        name: "Snapshot test",
        scopes: ["openid", "read", "write", "admin"],
      });
      if (!credential.ok) throw new Error(credential.error.message);
      for (const locale of ["en", "de"]) {
        for (const path of ["config", "run"]) {
          const response = await api.request(`/${shortId}/snapshots/${path}`, {
            method: path === "config" ? "PUT" : "POST",
            headers: { authorization: `Bearer ${credential.data.token}`, "accept-language": locale, "content-type": "application/json" },
            ...(path === "config" ? { body: JSON.stringify(data) } : {}),
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({
            code: "NOTEBOOK_SNAPSHOT_TARGET_BLOCKED",
            message: notebookServiceMessages.resolve([locale]).t.snapshotTargetBlocked,
          });
        }
      }
      expect((await updateConfig({ notebookId: id, userId, data: { enabled: false } })).ok).toBe(true);
    } finally {
      await sql`DELETE FROM logging.entries WHERE source = 'notebooks:snapshot:s3' AND metadata->>'notebookId' = ${id}`;
      await sql`DELETE FROM notebooks.notebooks WHERE id = ${id}::uuid`;
      if (accessId) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      if (accountId) {
        await sql`DELETE FROM auth.service_account_credentials WHERE service_account_id = ${accountId}::uuid`;
        await sql`DELETE FROM auth.service_accounts WHERE id = ${accountId}::uuid`;
      }
      await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    }
  }, 30_000);
});
