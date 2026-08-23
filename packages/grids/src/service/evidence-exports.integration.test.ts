import { beforeAll, describe, expect } from "bun:test";
import { createHash } from "node:crypto";
import { sql } from "bun";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { cancel, create as createExport, download, preflight, processExport, retry } from "./evidence-exports";

const collect = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const readTar = (bytes: Uint8Array): Map<string, Uint8Array> => {
  const entries = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const path = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim(), 8);
    offset += 512;
    entries.set(path, bytes.slice(offset, offset + size));
    offset += size + ((512 - (size % 512)) % 512);
  }
  return entries;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("evidence export integration", () => {
  postgresTest("includes profile metadata and exact artifacts through the common record-bound Document evidence path", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const documentId = testUuid();
    const recordId = testUuid();
    const templateId = testUuid();
    const snapshotId = testUuid();
    const pdfFileId = testUuid();
    const structuredFileId = testUuid();
    const exportId = testUuid();
    const tableExportId = testUuid();
    const serviceAccountId = testUuid();
    const baseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const documentShortId = testShortId("D");
    const exportShortId = testShortId("E");
    const tableExportShortId = testShortId("X");
    const pdf = new TextEncoder().encode("%PDF-1.7\nimmutable statement");
    const structured = new TextEncoder().encode('{"number":"STAT-0001","total":"119.00"}');
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Business evidence')`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Orders')`;
      await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${recordId}::uuid, ${testShortId("R")}, ${tableId}::uuid, '{}'::jsonb)`;
      await sql`
        INSERT INTO grids.document_templates (
          id, short_id, table_id, name, source, renderer_kind, profile_id, profile_version, profile_input_template
        ) VALUES (
          ${templateId}::uuid, ${testShortId("T")}, ${tableId}::uuid, 'Statement', 'from table Orders',
          'profile', 'test.statement', 1, '{}'
        )
      `;
      await sql`
        INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph)
        VALUES (${snapshotId}::uuid, ${testShortId("S")}, ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, '{"version":1}'::jsonb, '{}'::jsonb)
      `;
      await sql`
        INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes) VALUES
          (${pdfFileId}::uuid, ${testShortId("F")}, 'statement.pdf', 'application/pdf', ${pdf.byteLength}, ${digest(pdf)}, ${pdf}),
          (${structuredFileId}::uuid, ${testShortId("F")}, 'statement.json', 'application/json', ${structured.byteLength}, ${digest(structured)}, ${structured})
      `;
      await sql`
        INSERT INTO grids.documents (
          id, short_id, template_id, snapshot_id, base_id, table_id, record_id, renderer_kind, profile_id, profile_version,
          source, source_revision, profile_snapshot, snapshot_sha256, document_number, filename, tags,
          template_snapshot, render_data, relationship_kind,
          renderer_version, template_revision, validator_version, validation_status, validation_report, issued_actor, created_at
        ) VALUES (
          ${documentId}::uuid, ${documentShortId}, ${templateId}::uuid, ${snapshotId}::uuid,
          ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, 'profile', 'test.statement', 1,
          ${{ appId: "orders", resourceType: "order", resourceId: "42" }}::jsonb,
          ${{ id: "v7", observedAt: "2026-08-22T10:00:00.000Z", evidence: { version: 7 } }}::jsonb,
          ${{ number: "STAT-0001", total: "119.00" }}::jsonb, ${"c".repeat(64)}, 'STAT-0001', 'statement.pdf', '{}',
          ${{ renderer: { kind: "profile", id: "test.statement", version: 1, inputTemplate: "{}" } }}::jsonb, '{}'::jsonb, 'original',
          'renderer-v1', ${"d".repeat(64)}, 'validator-v1', 'valid', ${{ arithmetic: "exact-decimal" }}::jsonb,
          ${{ kind: "service_account", serviceAccountId, delegatedUserId: null, credentialId: null }}::jsonb,
          '2026-08-22T10:00:00.000Z'
        )
      `;
      await sql`
        INSERT INTO grids.file_protected_references (file_id, owner_kind, owner_id, base_id, table_id, record_id) VALUES
          (${pdfFileId}::uuid, 'document_artifact', ${documentId}::uuid, ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid),
          (${structuredFileId}::uuid, 'document_artifact', ${documentId}::uuid, ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid)
      `;
      await sql`
        INSERT INTO grids.document_artifacts (document_id, artifact_key, file_id) VALUES
          (${documentId}::uuid, 'pdf', ${pdfFileId}::uuid),
          (${documentId}::uuid, 'structured', ${structuredFileId}::uuid)
      `;
      const preview = await preflight({ baseId, tableId: null, from: null, to: null, sections: ["documents"] });
      expect(preview.known).toMatchObject({ documents: 1, documentEntries: 3, documentBytes: pdf.byteLength + structured.byteLength });

      await sql`
        INSERT INTO grids.evidence_exports (id, short_id, base_id, sections)
        VALUES (${exportId}::uuid, ${exportShortId}, ${baseId}::uuid, ARRAY['documents'])
      `;
      await processExport(exportId);
      const result = await download(exportShortId);
      if (!result.ok) throw result.error;
      const entries = readTar(await collect(result.data.body));
      expect(entries.get(`documents/${documentShortId}/statement.pdf`)).toEqual(pdf);
      expect(entries.get(`documents/${documentShortId}/statement.json`)).toEqual(structured);
      const metadata = new TextDecoder().decode(entries.get(`documents/metadata/${documentShortId}.json`));
      expect(metadata).toContain('"total": "119.00"');
      expect(metadata).toContain('"document_number": "STAT-0001"');
      expect(metadata).toContain('"kind": "service_account"');
      expect(metadata).toContain('"serviceAccountId": "private:');
      expect(metadata).not.toContain(documentId);
      expect(metadata).not.toContain(baseId);
      expect(metadata).not.toContain(serviceAccountId);

      await sql`
        INSERT INTO grids.evidence_exports (id, short_id, base_id, table_id, sections)
        VALUES (${tableExportId}::uuid, ${tableExportShortId}, ${baseId}::uuid, ${tableId}::uuid, ARRAY['documents'])
      `;
      await processExport(tableExportId);
      const tableResult = await download(tableExportShortId);
      if (!tableResult.ok) throw tableResult.error;
      const tableEntries = readTar(await collect(tableResult.data.body));
      expect([...tableEntries.keys()].some((path) => path.includes(documentShortId))).toBe(true);
    } finally {
      void baseId;
    }
  });

  postgresTest("packages the exact bounded evidence cut from every existing owner without private IDs", async () => {
    const actorId = testUuid();
    const baseId = testUuid();
    const tableId = testUuid();
    const noHistoryTableId = testUuid();
    const textFieldId = testUuid();
    const relationFieldId = testUuid();
    const fileFieldId = testUuid();
    const recordId = testUuid();
    const targetRecordId = testUuid();
    const schemaRevisionId = testUuid();
    const revisionId = testUuid();
    const templateId = testUuid();
    const snapshotId = testUuid();
    const documentId = testUuid();
    const attachmentFileId = testUuid();
    const artifactFileId = testUuid();
    const seriesId = testUuid();
    const allocationId = testUuid();
    const exportId = testUuid();
    const interruptedExportId = testUuid();
    const baseShortId = testShortId("B");
    const tableShortId = testShortId("T");
    const noHistoryTableShortId = testShortId("H");
    const textFieldShortId = testShortId("F");
    const relationFieldShortId = testShortId("L");
    const fileFieldShortId = testShortId("A");
    const recordShortId = testShortId("R");
    const targetRecordShortId = testShortId("Q");
    const revisionShortId = testShortId("V");
    const templateShortId = testShortId("D");
    const snapshotShortId = testShortId("S");
    const documentShortId = testShortId("N");
    const attachmentShortId = testShortId("I");
    const artifactShortId = testShortId("P");
    const seriesShortId = testShortId("C");
    const exportShortId = testShortId("E");
    const interruptedExportShortId = testShortId("J");
    const attachmentBytes = new TextEncoder().encode("exact attached evidence");
    const artifactBytes = new TextEncoder().encode("%PDF-1.7\nexact stored document");
    const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

    try {
      await sql`
        INSERT INTO auth.users (id, uid, provider, profile, display_name, given_name, sn)
        VALUES (${actorId}::uuid, ${`evidence-${actorId}`}, 'local', 'user', 'Evidence Admin', 'Evidence', 'Admin')
      `;
      await sql`INSERT INTO grids.bases (id, short_id, name, created_by) VALUES (${baseId}::uuid, ${baseShortId}, 'Evidence fixture', ${actorId}::uuid)`;
      await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${tableShortId}, ${baseId}::uuid, 'Cases')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${noHistoryTableId}::uuid, ${noHistoryTableShortId}, ${baseId}::uuid, 'Cases without history')
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position) VALUES
          (${textFieldId}::uuid, ${textFieldShortId}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0),
          (${relationFieldId}::uuid, ${relationFieldShortId}, ${tableId}::uuid, 'Related', 'relation', ${{ targetTableId: tableId }}::jsonb, 1),
          (${fileFieldId}::uuid, ${fileFieldShortId}, ${tableId}::uuid, 'Files', 'file', '{}'::jsonb, 2)
      `;
      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data, created_by, updated_by) VALUES
          (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, ${{ [textFieldId]: "Case 1" }}::jsonb, ${actorId}::uuid, ${actorId}::uuid),
          (${targetRecordId}::uuid, ${targetRecordShortId}, ${tableId}::uuid, ${{ [textFieldId]: "Related case" }}::jsonb, ${actorId}::uuid, ${actorId}::uuid)
      `;
      await sql`
        INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id)
        VALUES (${recordId}::uuid, ${relationFieldId}::uuid, ${targetRecordId}::uuid)
      `;
      await sql`
        INSERT INTO grids.table_schema_revisions (id, table_id, schema_hash, fields)
        VALUES (${schemaRevisionId}::uuid, ${tableId}::uuid, ${"a".repeat(64)}, ${{ [textFieldId]: { type: "text" } }}::jsonb)
      `;
      await sql`
        INSERT INTO grids.durable_history_activations (table_id, baseline_schema_revision_id, status, activated_by, activated_at, baseline_completed_at)
        VALUES (${tableId}::uuid, ${schemaRevisionId}::uuid, 'active', ${actorId}::uuid, now(), now())
      `;
      await sql`
        INSERT INTO grids.record_revisions (
          id, short_id, table_id, record_id, schema_revision_id, revision_no, action, record_version,
          data, relations, changed_field_ids, actor_id, actor_display_name
        ) VALUES (
          ${revisionId}::uuid, ${revisionShortId}, ${tableId}::uuid, ${recordId}::uuid, ${schemaRevisionId}::uuid,
          1, 'finalized', 1, ${{ [textFieldId]: "Case 1" }}::jsonb,
          ${{ [relationFieldId]: [targetRecordId] }}::jsonb, ${sql.array([textFieldId], "UUID")}::uuid[], ${actorId}::uuid, 'Evidence Admin'
        )
      `;
      await sql`INSERT INTO grids.table_finalization_activations (table_id, enabled_by) VALUES (${tableId}::uuid, ${actorId}::uuid)`;
      await sql`UPDATE grids.records SET finalized_at = now(), finalized_by = ${actorId}::uuid, final_revision_id = ${revisionId}::uuid WHERE id = ${recordId}::uuid`;
      await sql`
        INSERT INTO grids.audit_log (base_id, table_id, record_id, user_id, action, diff, context)
        VALUES (${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, ${actorId}::uuid, 'record.finalized', ${{ final_revision_id: revisionId }}::jsonb, '{}'::jsonb)
      `;
      await sql`
        INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes, created_by) VALUES
          (${attachmentFileId}::uuid, ${attachmentShortId}, 'evidence.txt', 'text/plain', ${attachmentBytes.byteLength}, ${sha256(attachmentBytes)}, ${attachmentBytes}, ${actorId}::uuid),
          (${artifactFileId}::uuid, ${artifactShortId}, 'case.pdf', 'application/pdf', ${artifactBytes.byteLength}, ${sha256(artifactBytes)}, ${artifactBytes}, ${actorId}::uuid)
      `;
      await sql`
        INSERT INTO grids.file_attachments (file_id, record_id, field_id, attached_by)
        VALUES (${attachmentFileId}::uuid, ${recordId}::uuid, ${fileFieldId}::uuid, ${actorId}::uuid)
      `;
      await sql`
        INSERT INTO grids.document_templates (
          id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template, created_by, updated_by
        ) VALUES (
          ${templateId}::uuid, ${templateShortId}, ${tableId}::uuid, 'Case PDF', 'from table', 'html', '<p>Case</p>',
          'CASE-{{ series.value }}', '{{ document.number }}.pdf', ${actorId}::uuid, ${actorId}::uuid
        )
      `;
      await sql`
        INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph, created_by)
        VALUES (${snapshotId}::uuid, ${snapshotShortId}, ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid,
          ${{ id: recordId, values: { [textFieldId]: "Case 1" } }}::jsonb,
          ${{ rootId: recordId, records: { [recordId]: { id: recordId } } }}::jsonb, ${actorId}::uuid)
      `;
      await sql`
        INSERT INTO grids.documents (
          id, short_id, template_id, snapshot_id, base_id, table_id, record_id, document_number, filename,
          template_snapshot, render_data, renderer_kind, renderer_version, template_revision, issued_actor, created_by
        ) VALUES (
          ${documentId}::uuid, ${documentShortId}, ${templateId}::uuid, ${snapshotId}::uuid, ${baseId}::uuid, ${tableId}::uuid,
          ${recordId}::uuid, 'CASE-1', 'case.pdf',
          ${{ renderer: { kind: "html", body: "<p>Case</p>", numberTemplate: "CASE-{{ series.value }}", filenameTemplate: "{{ document.number }}.pdf" } }}::jsonb,
          '{}'::jsonb, 'html', 'fixture-renderer', ${"b".repeat(64)}, ${{ kind: "user", userId: actorId }}::jsonb, ${actorId}::uuid
        )
      `;
      await sql`
        INSERT INTO grids.file_protected_references (file_id, owner_kind, owner_id, base_id, table_id, record_id, created_by)
        VALUES (${artifactFileId}::uuid, 'document_artifact', ${documentId}::uuid, ${baseId}::uuid, ${tableId}::uuid, ${recordId}::uuid, ${actorId}::uuid)
      `;
      await sql`
        INSERT INTO grids.document_artifacts (document_id, artifact_key, file_id)
        VALUES (${documentId}::uuid, 'pdf', ${artifactFileId}::uuid)
      `;
      await sql`
        INSERT INTO grids.number_series (id, short_id, owner_kind, field_id) VALUES (${seriesId}::uuid, ${seriesShortId}, 'field', ${textFieldId}::uuid)
      `;
      await sql`
        INSERT INTO grids.number_series_versions (series_id, version, strategy, prefix, padding)
        VALUES (${seriesId}::uuid, 1, 'sequence', 'CASE-', 4)
      `;
      await sql`
        INSERT INTO grids.number_allocations (id, series_id, version, scope, value, rendered_value, consumer_kind, consumer_id)
        VALUES (${allocationId}::uuid, ${seriesId}::uuid, 1, 'global', 1, 'CASE-0001', 'record', ${recordId}::uuid)
      `;
      await sql`
        INSERT INTO grids.evidence_exports (id, short_id, base_id, table_id, requested_by, requested_by_display_name, sections)
        VALUES (${exportId}::uuid, ${exportShortId}, ${baseId}::uuid, ${tableId}::uuid, ${actorId}::uuid, 'Evidence Admin',
          ARRAY['records','revisions','audit','schema','relations','files','documents','numbers'])
      `;

      const coveragePreview = await preflight({ baseId, tableId: null, from: null, to: null, sections: ["revisions"] });
      expect(coveragePreview.history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tableId: tableShortId, enabled: true, baselineComplete: true }),
          expect.objectContaining({ tableId: noHistoryTableShortId, enabled: false, baselineComplete: false }),
        ]),
      );
      expect(coveragePreview.known).toMatchObject({ numberSeries: 1, numberSeriesVersions: 1, numberAllocations: 1 });
      expect(coveragePreview.tables).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tableId: tableShortId,
            name: "Cases",
            records: 2,
            history: expect.objectContaining({ state: "active", baselineComplete: true }),
            finalization: { enabled: true, finalizedRecords: 1 },
          }),
          expect.objectContaining({
            tableId: noHistoryTableShortId,
            name: "Cases without history",
            records: 0,
            history: expect.objectContaining({ state: "unavailable", baselineComplete: false }),
            finalization: { enabled: false, finalizedRecords: 0 },
          }),
        ]),
      );
      expect(coveragePreview.warnings).toContain(
        `Table ${noHistoryTableShortId} has no Durable History; earlier record states are not available.`,
      );

      await processExport(exportId);
      const result = await download(exportShortId);
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      const archive = await collect(result.data.body);
      const entries = readTar(archive);
      const manifestBytes = entries.get("manifest.json");
      if (!manifestBytes) throw new Error("Manifest missing");
      const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
        counts: Record<string, number>;
        entries: Array<{ path: string; sha256: string }>;
        coverage: {
          completeWithinAvailableCoverage: boolean;
          history: Array<{ baselineComplete: boolean }>;
          sources: Array<{ section: string; currentAt: string | null; from: string | null; to: string | null }>;
        };
      };

      expect(manifest.counts).toMatchObject({ records: 2, revisions: 1, audit: 1, relations: 1, files: 1, documents: 1, numbers: 3 });
      expect(manifest.counts.schema).toBeGreaterThanOrEqual(7);
      expect(manifest.coverage).toMatchObject({ completeWithinAvailableCoverage: true, history: [{ baselineComplete: true }] });
      expect(manifest.coverage.sources.map((source) => source.section)).toEqual([
        "records",
        "revisions",
        "audit",
        "schema",
        "relations",
        "files",
        "documents",
        "numbers",
      ]);
      expect(typeof manifest.coverage.sources.find((source) => source.section === "records")?.currentAt).toBe("string");
      expect(manifest.coverage.sources.find((source) => source.section === "documents")).toMatchObject({
        currentAt: null,
        from: null,
        to: null,
      });
      expect(entries.get(`files/${attachmentShortId}/evidence.txt`)).toEqual(attachmentBytes);
      expect(entries.get(`documents/${documentShortId}/case.pdf`)).toEqual(artifactBytes);
      for (const entry of manifest.entries) {
        const bytes = entries.get(entry.path);
        expect(bytes).toBeDefined();
        expect(createHash("sha256").update(bytes!).digest("hex")).toBe(entry.sha256);
      }
      for (const privateId of [
        actorId,
        baseId,
        tableId,
        textFieldId,
        relationFieldId,
        fileFieldId,
        recordId,
        targetRecordId,
        schemaRevisionId,
        revisionId,
        templateId,
        snapshotId,
        documentId,
        attachmentFileId,
        artifactFileId,
        seriesId,
        allocationId,
      ]) {
        const leakingPaths = [...entries]
          .filter(([path, bytes]) => path.endsWith(".json") && new TextDecoder().decode(bytes).includes(privateId))
          .map(([path]) => path);
        expect({ privateId, leakingPaths }).toEqual({ privateId, leakingPaths: [] });
      }
      const serialized = new TextDecoder().decode(archive);
      expect(serialized).toContain(baseShortId);
      expect(serialized).toContain(recordShortId);
      expect(serialized).toContain(relationFieldShortId);
      expect(result.data.sha256).toBe(createHash("sha256").update(archive).digest("hex"));

      await processExport(exportId);
      const replay = await download(exportShortId);
      expect(replay.ok).toBe(true);
      if (!replay.ok) throw replay.error;
      expect(
        createHash("sha256")
          .update(await collect(replay.data.body))
          .digest("hex"),
      ).toBe(result.data.sha256);

      await sql`
        INSERT INTO grids.evidence_exports (id, short_id, base_id, table_id, sections)
        VALUES (${interruptedExportId}::uuid, ${interruptedExportShortId}, ${baseId}::uuid, ${tableId}::uuid, ARRAY['records'])
      `;
      expect(
        processExport(interruptedExportId, async () => {
          throw new Error("simulated worker interruption");
        }),
      ).rejects.toThrow("simulated worker interruption");
      const [interrupted] = await sql<Array<{ status: string; chunks: number }>>`
        SELECT export.status, (SELECT count(*)::int FROM grids.evidence_export_chunks chunk WHERE chunk.export_id = export.id) AS chunks
        FROM grids.evidence_exports export WHERE export.id = ${interruptedExportId}::uuid
      `;
      expect(interrupted).toEqual({ status: "running", chunks: 0 });
      await Promise.all([processExport(interruptedExportId), processExport(interruptedExportId)]);
      const recovered = await download(interruptedExportShortId);
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) throw recovered.error;
      const recoveredArchive = await collect(recovered.data.body);
      expect(createHash("sha256").update(recoveredArchive).digest("hex")).toBe(recovered.data.sha256);

      const [domainCounts] = await sql<Array<{ records: number; revisions: number; documents: number; allocations: number }>>`
        SELECT
          (SELECT count(*)::int FROM grids.records WHERE table_id = ${tableId}::uuid) AS records,
          (SELECT count(*)::int FROM grids.record_revisions WHERE table_id = ${tableId}::uuid) AS revisions,
          (SELECT count(*)::int FROM grids.documents WHERE table_id = ${tableId}::uuid) AS documents,
          (SELECT count(*)::int FROM grids.number_allocations WHERE series_id = ${seriesId}::uuid) AS allocations
      `;
      expect(domainCounts).toEqual({ records: 2, revisions: 1, documents: 1, allocations: 1 });
    } finally {
      void baseId;
    }
  });

  postgresTest("cancels queued work, retries terminal work once, and removes expired package bytes", async () => {
    const baseId = testUuid();
    const baseShortId = testShortId("B");
    const canceledId = testUuid();
    const canceledShortId = testShortId("C");
    const expiredId = testUuid();
    const expiredShortId = testShortId("X");
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${baseShortId}, 'Evidence lifecycle fixture')`;
      await sql`
        INSERT INTO grids.evidence_exports (id, short_id, base_id, sections)
        VALUES (${canceledId}::uuid, ${canceledShortId}, ${baseId}::uuid, ARRAY['records'])
      `;
      const canceled = await cancel(canceledShortId);
      expect(canceled).toMatchObject({ ok: true, data: { status: "canceled" } });
      const retried = await retry(canceledShortId);
      expect(retried).toMatchObject({ ok: true, data: { status: "queued" } });
      const [retryRow] = await sql<Array<{ attempt: number; status: string }>>`
        SELECT attempt, status FROM grids.evidence_exports WHERE id = ${canceledId}::uuid
      `;
      expect(retryRow).toEqual({ attempt: 2, status: "queued" });

      await sql`
        INSERT INTO grids.evidence_exports (
          id, short_id, base_id, sections, status, package_filename, package_size_bytes,
          package_sha256, manifest_sha256, manifest, completed_at, expires_at
        ) VALUES (
          ${expiredId}::uuid, ${expiredShortId}, ${baseId}::uuid, ARRAY['records'], 'completed', 'expired.tar', 3,
          ${"a".repeat(64)}, ${"b".repeat(64)}, '{}'::jsonb, now() - interval '8 days', now() - interval '1 day'
        )
      `;
      await sql`INSERT INTO grids.evidence_export_chunks (export_id, sequence, bytes) VALUES (${expiredId}::uuid, 0, ${new TextEncoder().encode("tar")})`;
      const expired = await download(expiredShortId);
      expect(expired.ok).toBe(false);
      const [expiredRow] = await sql<Array<{ status: string; chunk_count: number }>>`
        SELECT export.status, (SELECT count(*)::int FROM grids.evidence_export_chunks chunk WHERE chunk.export_id = export.id) AS chunk_count
        FROM grids.evidence_exports export WHERE export.id = ${expiredId}::uuid
      `;
      expect(expiredRow).toEqual({ status: "expired", chunk_count: 0 });
    } finally {
      await sql`DELETE FROM grids.evidence_exports WHERE base_id = ${baseId}::uuid`;
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });

  postgresTest("rejects a large known scope before queueing or building a partial package", async () => {
    const baseId = testUuid();
    const tableId = testUuid();
    const publicPrefix = testShortId("Z").slice(0, 2);
    try {
      await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Large evidence fixture')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name)
        VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Many records')
      `;
      for (let offset = 0; offset < 25_001; offset += 500) {
        const values = Array.from({ length: Math.min(500, 25_001 - offset) }, (_, index) => {
          const shortId = `${publicPrefix}${(offset + index).toString(36).padStart(4, "0")}`;
          return sql`(gen_random_uuid(), ${shortId}, ${tableId}::uuid, '{}'::jsonb)`;
        }).reduce((left, right) => sql`${left}, ${right}`);
        await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES ${values}`;
      }

      const preview = await preflight({ baseId, tableId, from: null, to: null, sections: ["records"] });
      expect(preview.known.records).toBe(25_001);
      expect(preview.tables).toEqual([expect.objectContaining({ records: 25_001, history: expect.objectContaining({ state: "legacy" }) })]);
      expect(preview.withinKnownBudgets).toBe(false);
      expect(preview.warnings).toContain("The known entry count exceeds the export package limit.");
      const created = await createExport({
        baseId,
        tableId,
        from: null,
        to: null,
        sections: ["records"],
        requestedBy: null,
        requestedByDisplayName: null,
      });
      expect(created.ok).toBe(false);
      const [queued] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.evidence_exports WHERE base_id = ${baseId}::uuid
      `;
      expect(queued?.count).toBe(0);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
    }
  });
});
