import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { serviceAccountCredentials } from "@k2b/cloud/services";
import { sql } from "bun";
import { z } from "zod";
import { tinyJpeg, withCameraMetadata } from "../../../../scripts/fixtures/image-metadata";
import "../../../../scripts/fixtures/authorization-preload";
import { testInfra } from "../../../../scripts/fixtures/test-infra";
import { migrate as migrateCoreWorkflows } from "../../../core/src/migrate/core/workflows";
import recordsApi from "../api/records";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as fields from "./fields";
import { cleanup, getProtectedContent, listForRecordField, protect, releaseProtection, remove, replace, upload } from "./files";
import * as forms from "./forms";
import * as records from "./record-write";

beforeAll(async () => {
  if (!testInfra.database) return;
  await migrateCoreWorkflows();
  await migrate();
});

const createFixture = async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId()}, 'File lifecycle')`;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name)
    VALUES (${tableId}::uuid, ${testShortId()}, ${baseId}::uuid, 'Records')
  `;
  const field = await fields.create({ tableId, name: "Attachments", type: "file", config: { maxFiles: 3 } }, null);
  if (!field.ok) throw field.error;
  const record = await records.create(tableId, {}, null, "direct");
  if (!record.ok) throw record.error;
  return { baseId, tableId, fieldId: field.data.id, recordId: record.data.id };
};

const destroyFixture = async (baseId: string) => {
  await sql`DELETE FROM grids.file_protected_references WHERE base_id = ${baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
  await sql`
    DELETE FROM grids.files file
    WHERE NOT EXISTS (SELECT 1 FROM grids.file_attachments attachment WHERE attachment.file_id = file.id)
      AND NOT EXISTS (SELECT 1 FROM grids.file_protected_references protected WHERE protected.file_id = file.id)
  `;
};

const bytes = (value: string) => new TextEncoder().encode(value);

describe("durable file asset lifecycle Postgres integration", () => {
  test("refuses to release immutable Document artifact protection before accessing storage", async () => {
    const result = await releaseProtection({
      fileId: testUuid(),
      ownerKind: "document_artifact",
      ownerId: testUuid(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BAD_INPUT");
      expect(result.error.message).toBe("Protection for a document artifact cannot be released.");
    }
  });

  postgresTest("uploads and replacements strip metadata at service/API boundaries, including Form title images", async () => {
    const fixture = await createFixture();
    const [account] = await sql<{ id: string }[]>`
      INSERT INTO auth.service_accounts (name, kind) VALUES (${`Grid photo ${testShortId()}`}, 'agent') RETURNING id
    `;
    try {
      const jpeg = await tinyJpeg();
      const input = withCameraMetadata(jpeg, 1);
      const added = await upload({
        ...fixture,
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        bytes: input,
        userId: null,
        origin: "direct",
      });
      if (!added.ok) throw added.error;
      const replaced = await replace({
        ...fixture,
        fileId: added.data.id,
        filename: "replacement.jpg",
        mimeType: "image/png",
        bytes: input,
        userId: null,
        origin: "direct",
      });
      if (!replaced.ok) throw replaced.error;
      const hash = createHash("sha256").update(jpeg).digest("hex");
      expect(replaced.data).toMatchObject({ sizeBytes: jpeg.length, sha256: hash });
      const [stored] = await sql<{ bytes: Uint8Array; sha256: string; size_bytes: number | string }[]>`
        SELECT bytes, sha256, size_bytes FROM grids.files WHERE id = ${replaced.data.id}::uuid
      `;
      expect(stored).toMatchObject({ bytes: jpeg, sha256: hash });
      expect(Number(stored?.size_bytes)).toBe(jpeg.length);
      const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (service_account_id, permission) VALUES (${account!.id}::uuid, 'write') RETURNING id
      `;
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${fixture.baseId}::uuid, ${access!.id}::uuid)`;
      const token = await serviceAccountCredentials.createApiToken({
        serviceAccountId: account!.id,
        name: "photos",
        scopes: ["read", "write"],
      });
      if (!token.ok) throw token.error;
      const [ids] = await sql<{ table_id: string; record_id: string; field_id: string }[]>`
        SELECT t.short_id AS table_id, r.short_id AS record_id, f.short_id AS field_id
        FROM grids.tables t JOIN grids.records r ON r.table_id=t.id JOIN grids.fields f ON f.table_id=t.id
        WHERE r.id=${fixture.recordId}::uuid AND f.id=${fixture.fieldId}::uuid
      `;
      const path = `/${ids!.table_id}/${ids!.record_id}/files/${ids!.field_id}`;
      const post = (bytes: Uint8Array, fileId?: string) => {
        const form = new FormData();
        form.set("file", new File([new Uint8Array(bytes)], "photo.jpg", { type: "image/jpeg" }));
        return recordsApi.request(fileId ? `${path}/${fileId}` : path, {
          method: fileId ? "PUT" : "POST",
          headers: { authorization: `Bearer ${token.data.token}` },
          body: form,
        });
      };
      const response = await post(input);
      expect(response.status).toBe(200);
      const file = z.object({ id: z.string(), sizeBytes: z.number(), sha256: z.string() }).parse(await response.json());
      expect(file).toMatchObject({ sizeBytes: jpeg.length, sha256: hash });
      const downloaded = await recordsApi.request(`${path}/${file.id}/content`, {
        headers: { authorization: `Bearer ${token.data.token}` },
      });
      expect(downloaded.status).toBe(200);
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(jpeg);
      expect((await post(input.subarray(0, 30))).status).toBe(422);
      expect((await post(input.subarray(0, 30), file.id)).status).toBe(422);
      const titleImage = `data:image/jpeg;base64,${Buffer.from(input).toString("base64")}`;
      const form = await forms.create({ tableId: fixture.tableId, name: "Photo form", config: { fields: [], titleImage } }, null);
      if (!form.ok) throw form.error;
      const sanitizedTitle = `data:image/jpeg;base64,${Buffer.from(jpeg).toString("base64")}`;
      expect(form.data.config.titleImage).toBe(sanitizedTitle);
      const updated = await forms.update(form.data.id, { config: { fields: [], titleImage } }, null);
      if (!updated.ok) throw updated.error;
      expect(updated.data.config.titleImage).toBe(sanitizedTitle);
    } finally {
      await destroyFixture(fixture.baseId);
      await sql`DELETE FROM auth.service_accounts WHERE id = ${account!.id}::uuid`;
    }
  });

  postgresTest("keeps protected exact bytes after detach and cleans them after the last protection is released", async () => {
    const fixture = await createFixture();
    const ownerId = testUuid();
    try {
      const added = await upload({
        ...fixture,
        filename: "evidence.txt",
        mimeType: "text/plain",
        bytes: bytes("exact evidence"),
        userId: null,
        origin: "direct",
      });
      expect(added.ok).toBe(true);
      if (!added.ok) throw added.error;

      expect(
        (
          await protect({
            fileId: added.data.id,
            ownerKind: "record_revision",
            ownerId,
            ...fixture,
            userId: null,
          })
        ).ok,
      ).toBe(true);
      expect((await remove({ ...fixture, fileId: added.data.id, userId: null, origin: "direct" })).ok).toBe(true);
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;

      const retained = await getProtectedContent({ fileId: added.data.id, ownerKind: "record_revision", ownerId });
      expect(retained.ok).toBe(true);
      if (!retained.ok) throw retained.error;
      expect(retained.data.shortId).toBe(added.data.shortId);
      expect(retained.data.sha256).toBe(added.data.sha256);
      expect(retained.data.bytes).toEqual(bytes("exact evidence"));

      const [audit] = await sql<Array<{ actions: string[]; diff: Record<string, unknown>[] }>>`
        SELECT array_agg(action ORDER BY created_at) AS actions, array_agg(diff ORDER BY created_at) AS diff
        FROM grids.audit_log
        WHERE record_id = ${fixture.recordId}::uuid AND action LIKE 'file.%'
      `;
      expect(audit?.actions).toEqual(["file.added", "file.removed"]);
      expect(audit?.diff.every((entry) => Object.hasOwn(entry, fixture.fieldId))).toBe(true);

      expect((await releaseProtection({ fileId: added.data.id, ownerKind: "record_revision", ownerId })).ok).toBe(true);
      expect((await getProtectedContent({ fileId: added.data.id, ownerKind: "record_revision", ownerId })).ok).toBe(false);
      const [asset] = await sql<Array<{ exists: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM grids.files WHERE id = ${added.data.id}::uuid) AS exists
      `;
      expect(asset?.exists).toBe(false);
    } finally {
      await destroyFixture(fixture.baseId);
    }
  });

  postgresTest("retains newly unreferenced assets under the Base floor and resets candidacy through protection", async () => {
    const fixture = await createFixture();
    const ownerId = testUuid();
    try {
      await sql`INSERT INTO grids.retention_policies (base_id, minimum_days) VALUES (${fixture.baseId}::uuid, 30)`;
      const original = await upload({
        ...fixture,
        filename: "retained-original.txt",
        mimeType: "text/plain",
        bytes: bytes("retained original"),
        userId: null,
        origin: "direct",
      });
      if (!original.ok) throw original.error;

      const replacement = await replace({
        ...fixture,
        fileId: original.data.id,
        filename: "retained-replacement.txt",
        mimeType: "text/plain",
        bytes: bytes("retained replacement"),
        userId: null,
        origin: "direct",
      });
      if (!replacement.ok) throw replacement.error;
      expect((await remove({ ...fixture, fileId: replacement.data.id, userId: null, origin: "direct" })).ok).toBe(true);

      const candidates = await sql<
        Array<{
          file_id: string;
          base_id: string;
          table_id: string | null;
          table_short_id: string | null;
          table_name: string | null;
          unreferenced_at: Date;
        }>
      >`
        SELECT file_id::text, base_id::text, table_id::text, table_short_id, table_name, unreferenced_at
        FROM grids.file_retention_candidates
        WHERE file_id IN (${original.data.id}::uuid, ${replacement.data.id}::uuid)
        ORDER BY file_id
      `;
      expect(candidates).toHaveLength(2);
      expect(candidates.every((candidate) => candidate.base_id === fixture.baseId)).toBe(true);
      expect(candidates.every((candidate) => candidate.table_id === fixture.tableId)).toBe(true);
      expect(candidates.every((candidate) => candidate.table_short_id && candidate.table_name === "Records")).toBe(true);
      const retainedCleanup = await cleanup(original.data.id);
      expect(retainedCleanup.ok).toBe(true);
      if (retainedCleanup.ok) expect(retainedCleanup.data).toBe(false);

      const firstUnreferencedAt = candidates.find((candidate) => candidate.file_id === original.data.id)?.unreferenced_at;
      expect(
        (
          await protect({
            fileId: original.data.id,
            ownerKind: "record_revision",
            ownerId,
            ...fixture,
            userId: null,
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await sql<Array<{ exists: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM grids.file_retention_candidates WHERE file_id = ${original.data.id}::uuid
            ) AS exists
          `
        )[0]?.exists,
      ).toBe(false);
      expect((await releaseProtection({ fileId: original.data.id, ownerKind: "record_revision", ownerId })).ok).toBe(true);
      const [renewed] = await sql<Array<{ unreferenced_at: Date; table_id: string | null; bytes: Uint8Array }>>`
        SELECT candidate.unreferenced_at, candidate.table_id::text, file.bytes
        FROM grids.file_retention_candidates candidate
        JOIN grids.files file ON file.id = candidate.file_id
        WHERE candidate.file_id = ${original.data.id}::uuid
      `;
      expect(renewed?.bytes).toEqual(bytes("retained original"));
      expect(renewed?.table_id).toBe(fixture.tableId);
      expect(renewed && firstUnreferencedAt && renewed.unreferenced_at >= firstUnreferencedAt).toBe(true);
    } finally {
      await destroyFixture(fixture.baseId);
    }
  });

  postgresTest("serializes detach and protection without exposing a retention deletion race", async () => {
    const fixture = await createFixture();
    try {
      await sql`INSERT INTO grids.retention_policies (base_id, minimum_days) VALUES (${fixture.baseId}::uuid, 30)`;
      for (let index = 0; index < 4; index += 1) {
        const added = await upload({
          ...fixture,
          filename: `retained-race-${index}.txt`,
          mimeType: "text/plain",
          bytes: bytes(`retained-race-${index}`),
          userId: null,
          origin: "direct",
        });
        if (!added.ok) throw added.error;
        const ownerId = testUuid();
        const [protectedResult, detached] = await Promise.all([
          protect({ fileId: added.data.id, ownerKind: "record_revision", ownerId, ...fixture, userId: null }),
          remove({ ...fixture, fileId: added.data.id, userId: null, origin: "direct" }),
        ]);
        expect(protectedResult.ok).toBe(true);
        expect(detached.ok).toBe(true);
        const content = await getProtectedContent({ fileId: added.data.id, ownerKind: "record_revision", ownerId });
        expect(content.ok).toBe(true);
        if (content.ok) expect(content.data.bytes).toEqual(bytes(`retained-race-${index}`));
        await releaseProtection({ fileId: added.data.id, ownerKind: "record_revision", ownerId });
      }
    } finally {
      await destroyFixture(fixture.baseId);
    }
  });

  postgresTest("replaces the current attachment atomically without destroying a protected previous asset", async () => {
    const fixture = await createFixture();
    const revisionId = testUuid();
    try {
      const original = await upload({
        ...fixture,
        filename: "original.txt",
        mimeType: "text/plain",
        bytes: bytes("original"),
        userId: null,
        origin: "direct",
      });
      if (!original.ok) throw original.error;
      const protectedResult = await protect({
        fileId: original.data.id,
        ownerKind: "record_revision",
        ownerId: revisionId,
        ...fixture,
        userId: null,
      });
      if (!protectedResult.ok) throw protectedResult.error;

      const replaced = await replace({
        ...fixture,
        fileId: original.data.id,
        filename: "corrected.txt",
        mimeType: "text/plain",
        bytes: bytes("corrected"),
        userId: null,
        origin: "direct",
      });
      expect(replaced.ok).toBe(true);
      if (!replaced.ok) throw replaced.error;
      expect(replaced.data.id).not.toBe(original.data.id);
      expect(replaced.data.position).toBe(original.data.position);

      const [attachment] = await sql<Array<{ file_id: string }>>`
        SELECT file_id::text FROM grids.file_attachments
        WHERE record_id = ${fixture.recordId}::uuid AND field_id = ${fixture.fieldId}::uuid
      `;
      expect(attachment?.file_id).toBe(replaced.data.id);
      const previous = await getProtectedContent({
        fileId: original.data.id,
        ownerKind: "record_revision",
        ownerId: revisionId,
      });
      expect(previous.ok).toBe(true);
      if (previous.ok) expect(previous.data.bytes).toEqual(bytes("original"));

      expect((await remove({ ...fixture, fileId: replaced.data.id, userId: null, origin: "direct" })).ok).toBe(true);
      const cleaned = await cleanup(replaced.data.id);
      expect(cleaned.ok).toBe(true);
      if (cleaned.ok) expect(cleaned.data).toBe(false);
      const [actions] = await sql<Array<{ actions: string[] }>>`
        SELECT array_agg(action ORDER BY created_at) AS actions
        FROM grids.audit_log
        WHERE record_id = ${fixture.recordId}::uuid AND action LIKE 'file.%'
      `;
      expect(actions?.actions).toEqual(["file.added", "file.replaced", "file.removed"]);
    } finally {
      await destroyFixture(fixture.baseId);
    }
  });

  postgresTest("restores the same current attachment after a record trash cycle", async () => {
    const fixture = await createFixture();
    try {
      const added = await upload({
        ...fixture,
        filename: "current.txt",
        mimeType: "text/plain",
        bytes: bytes("current"),
        userId: null,
        origin: "direct",
      });
      if (!added.ok) throw added.error;
      expect((await records.softDelete(fixture.tableId, fixture.recordId, null, "direct")).ok).toBe(true);
      expect((await listForRecordField(fixture)).ok).toBe(false);
      expect((await records.restore(fixture.tableId, fixture.recordId, null, "direct")).ok).toBe(true);
      const restored = await listForRecordField(fixture);
      expect(restored.ok).toBe(true);
      if (restored.ok) expect(restored.data.map((file) => file.id)).toEqual([added.data.id]);
    } finally {
      await destroyFixture(fixture.baseId);
    }
  });

  postgresTest("rolls back the asset and attachment when the required audit write fails", async () => {
    const fixture = await createFixture();
    const suffix = fixture.recordId.replaceAll("-", "");
    const functionName = `reject_file_audit_${suffix}`;
    const triggerName = `reject_file_audit_${suffix}`;
    try {
      await sql.unsafe(`
        CREATE FUNCTION grids.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.record_id = '${fixture.recordId}'::uuid AND NEW.action = 'file.added' THEN
            RAISE EXCEPTION 'intentional file audit failure';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await sql.unsafe(`
        CREATE TRIGGER ${triggerName}
        BEFORE INSERT ON grids.audit_log
        FOR EACH ROW EXECUTE FUNCTION grids.${functionName}()
      `);

      await expect(
        upload({
          ...fixture,
          filename: "must-rollback.txt",
          mimeType: "text/plain",
          bytes: bytes("must rollback"),
          userId: null,
          origin: "direct",
        }),
      ).rejects.toThrow("intentional file audit failure");
      const [state] = await sql<Array<{ assets: number; attachments: number }>>`
        SELECT
          (SELECT count(*)::int FROM grids.files WHERE filename = 'must-rollback.txt') AS assets,
          (SELECT count(*)::int FROM grids.file_attachments WHERE record_id = ${fixture.recordId}::uuid) AS attachments
      `;
      expect(state).toEqual({ assets: 0, attachments: 0 });
    } finally {
      await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON grids.audit_log`);
      await sql.unsafe(`DROP FUNCTION IF EXISTS grids.${functionName}()`);
      await destroyFixture(fixture.baseId);
    }
  });

  postgresTest("serializes protection against detach and never deletes a successfully protected asset", async () => {
    const fixture = await createFixture();
    try {
      for (let index = 0; index < 8; index += 1) {
        const added = await upload({
          ...fixture,
          filename: `race-${index}.txt`,
          mimeType: "text/plain",
          bytes: bytes(`race-${index}`),
          userId: null,
          origin: "direct",
        });
        if (!added.ok) throw added.error;
        const ownerId = testUuid();
        const [protectedResult, detached] = await Promise.all([
          protect({
            fileId: added.data.id,
            ownerKind: "record_revision",
            ownerId,
            ...fixture,
            userId: null,
          }),
          remove({ ...fixture, fileId: added.data.id, userId: null, origin: "direct" }),
        ]);
        expect(detached.ok).toBe(true);
        if (protectedResult.ok) {
          const content = await getProtectedContent({ fileId: added.data.id, ownerKind: "record_revision", ownerId });
          expect(content.ok).toBe(true);
          if (content.ok) expect(content.data.bytes).toEqual(bytes(`race-${index}`));
          await releaseProtection({ fileId: added.data.id, ownerKind: "record_revision", ownerId });
        } else {
          expect(protectedResult.error.status).toBe(404);
        }
      }
    } finally {
      await destroyFixture(fixture.baseId);
    }
  });
});
