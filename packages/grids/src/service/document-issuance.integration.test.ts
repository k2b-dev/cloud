import { beforeAll, describe, expect } from "bun:test";
import { err, fail } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import type { DocumentTemplate } from "../contracts";
import type { DocumentProfile } from "../document-profiles";
import { postgresTest, testShortId, testUuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { getDocumentPdf } from "./document-core";
import { createDocumentIssuanceService, type IssueDocumentInput } from "./document-issuance";
import { createTemplate, getTemplate } from "./document-templates";

const pdf = (label: string) => new TextEncoder().encode(`%PDF-1.7\n${label}`);

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

const createScope = async () => {
  const baseId = testUuid();
  const tableId = testUuid();
  const recordId = testUuid();
  const recordShortId = testShortId("R");
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${testShortId("B")}, 'Issuance')`;
  await sql`INSERT INTO grids.tables (id, short_id, base_id, name) VALUES (${tableId}::uuid, ${testShortId("T")}, ${baseId}::uuid, 'Invoices')`;
  await sql`
    INSERT INTO grids.records (id, short_id, table_id, data, version, updated_at)
    VALUES (${recordId}::uuid, ${recordShortId}, ${tableId}::uuid, '{}'::jsonb, 1, '2026-08-22T10:00:00.000Z')
  `;
  return { baseId, tableId, recordId, recordShortId };
};

const inputFor = (
  template: DocumentTemplate,
  scope: Awaited<ReturnType<typeof createScope>>,
  overrides: Partial<IssueDocumentInput> = {},
): IssueDocumentInput => {
  const root = {
    id: scope.recordId,
    table: { id: scope.tableId, shortId: testShortId("T"), name: "Invoices" },
    fields: [],
    data: {},
    version: 1,
    createdAt: "2026-08-22T10:00:00.000Z",
    updatedAt: "2026-08-22T10:00:00.000Z",
    deletedAt: null,
  };
  return {
    template,
    snapshot: {
      id: testUuid(),
      baseId: scope.baseId,
      tableId: scope.tableId,
      recordId: scope.recordId,
      root,
      graph: { rootId: `${scope.tableId}:${scope.recordId}`, records: { [`${scope.tableId}:${scope.recordId}`]: root } },
      createdBy: null,
      createdAt: "2026-08-22T10:00:00.000Z",
    },
    renderData: {
      record: { id: scope.recordShortId, shortId: scope.recordShortId, version: 1, updatedAt: "2026-08-22T10:00:00.000Z", data: {} },
      table: { id: testShortId("T"), name: "Invoices" },
    },
    actor: { kind: "system" },
    idempotencyKey: `issue-${testUuid()}`,
    ...overrides,
  };
};

const insertProfileTemplate = async (
  tableId: string,
  renderer: Extract<DocumentTemplate["renderer"], { kind: "profile" }>,
): Promise<DocumentTemplate> => {
  const id = testUuid();
  await sql`
    INSERT INTO grids.document_templates (
      id, short_id, table_id, name, source, renderer_kind,
      profile_id, profile_version, profile_input_template, enabled, position
    ) VALUES (
      ${id}::uuid, ${testShortId("D")}, ${tableId}::uuid, 'Statement', 'from table Invoices', 'profile',
      ${renderer.id}, ${renderer.version}, ${renderer.inputTemplate}, true, 0
    )
  `;
  const template = await getTemplate(id);
  if (!template) throw new Error("profile template missing");
  return template;
};

describe("Document issuance", () => {
  postgresTest("replays delayed HTML issuance and freezes its real public ID", async () => {
    const scope = await createScope();
    const created = await createTemplate(
      scope.tableId,
      {
        name: "Invoice",
        source: "from table Invoices",
        renderer: {
          kind: "html",
          body: "<p>{{ document.number }}</p>",
          numberTemplate: "DOC-{{ document.id }}-{{ series.value }}",
          filenameTemplate: "{{ document.number }}.pdf",
        },
      },
      null,
    );
    if (!created.ok) throw created.error;
    const service = createDocumentIssuanceService();
    const idempotencyKey = `html-${testUuid()}`;
    const input = inputFor(created.data, scope, {
      idempotencyKey,
      renderPdf: async (document) => ({ ok: true, data: { pdf: pdf(document.filename), contentType: "application/pdf" } }),
    });

    const first = await service.issueDocument(input);
    if (!first.ok) throw first.error;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const replay = await service.issueDocument(input);
    if (!replay.ok) throw replay.error;

    expect(first.data.replayed).toBe(false);
    expect(replay.data.replayed).toBe(true);
    expect(replay.data.document.id).toBe(first.data.document.id);
    expect(first.data.document.documentNumber).toContain(first.data.document.shortId);
    expect(first.data.document.artifacts).toHaveLength(1);
    expect(first.data.document.artifacts[0]?.fileId).toMatch(/^[0-9a-f-]{36}$/);
    const stored = await getDocumentPdf(first.data.document);
    expect(stored.ok).toBe(true);

    const [receipt] = await sql<Array<{ document_short_id: string; frozen_request: unknown; document_id: string }>>`
      SELECT document_short_id, frozen_request, document_id::text
      FROM grids.document_issuances WHERE document_id = ${first.data.document.id}::uuid
    `;
    expect(receipt).toEqual({ document_short_id: first.data.document.shortId, frozen_request: null, document_id: first.data.document.id });

    const large = await service.issueDocument({
      ...input,
      idempotencyKey: `large-${testUuid()}`,
      snapshot: { ...input.snapshot, id: testUuid() },
      renderData: { ...input.renderData, supportedPayload: "x".repeat(5 * 1024 * 1024 + 1) },
    });
    expect(large.ok).toBe(true);

    const invalidJson = await service.issueDocument({
      ...input,
      idempotencyKey: `invalid-json-${testUuid()}`,
      snapshot: { ...input.snapshot, id: testUuid() },
      renderData: { ...input.renderData, unsupported: 1n },
    });
    expect(invalidJson.ok).toBe(false);
    if (!invalidJson.ok) expect(invalidJson.error.code).toBe("BAD_INPUT");
  });

  postgresTest("rejects reuse with changed actor or binding and stores profile artifacts through Files", async () => {
    const scope = await createScope();
    const profile: DocumentProfile<{ title: string; issuedAt: string }> = {
      id: "test.statement",
      version: 1,
      title: "Statement",
      description: "Test profile",
      rendererVersion: "test-renderer-v1",
      validatorVersion: "test-validator-v1",
      input: z.object({ title: z.string(), issuedAt: z.iso.datetime() }).strict(),
      formatNumber: ({ value }) => `STAT-${value}`,
      issue: (value, context) => ({
        artifacts: [
          { key: "pdf", filename: `${context.number}.pdf`, mediaType: "application/pdf", bytes: pdf(value.title) },
          {
            key: "structured",
            filename: `${context.number}.json`,
            mediaType: "application/json",
            bytes: new TextEncoder().encode(JSON.stringify(value)),
          },
        ],
        validationStatus: "valid",
        validationReport: { valid: true },
      }),
    };
    const template = await insertProfileTemplate(scope.tableId, {
      kind: "profile",
      id: profile.id,
      version: profile.version,
      inputTemplate: '{"title":"Hello","issuedAt":"{{ date.iso }}"}',
    });
    const service = createDocumentIssuanceService({ profiles: [profile] });
    const idempotencyKey = `profile-${testUuid()}`;
    const input = inputFor(template, scope, { idempotencyKey });
    const issued = await service.issueDocument(input);
    if (!issued.ok) throw issued.error;
    expect(issued.data.document.artifacts.map((artifact) => artifact.key)).toEqual(["pdf", "structured"]);
    const structured = await service.getDocumentArtifact(issued.data.document.id, "structured");
    if (!structured.ok) throw structured.error;
    expect(JSON.parse(new TextDecoder().decode(structured.data.bytes)).issuedAt).toBe(issued.data.document.createdAt);

    const profileV2: DocumentProfile<{ title: string; issuedAt: string }> = { ...profile, version: 2 };
    const templateV2 = await insertProfileTemplate(scope.tableId, {
      kind: "profile",
      id: profileV2.id,
      version: profileV2.version,
      inputTemplate: '{"title":"Version 2","issuedAt":"{{ date.iso }}"}',
    });
    const versioned = await createDocumentIssuanceService({ profiles: [profile, profileV2] }).issueDocument(
      inputFor(templateV2, scope, { idempotencyKey: `profile-v2-${testUuid()}` }),
    );
    if (!versioned.ok) throw versioned.error;
    expect(versioned.data.document.documentNumber).toBe("STAT-2");

    const changedActor = await service.issueDocument({ ...input, actor: { kind: "user", userId: testUuid() } });
    expect(changedActor.ok).toBe(false);
    if (!changedActor.ok) expect(changedActor.error.code).toBe("CONFLICT");
    const changedRecordId = testUuid();
    const changedRoot = { ...input.snapshot.root, id: changedRecordId };
    const changedBinding = await service.issueDocument({
      ...input,
      snapshot: {
        ...input.snapshot,
        recordId: changedRecordId,
        root: changedRoot,
        graph: {
          rootId: `${scope.tableId}:${changedRecordId}`,
          records: { [`${scope.tableId}:${changedRecordId}`]: changedRoot },
        },
      },
    });
    expect(changedBinding.ok).toBe(false);
    if (!changedBinding.ok) expect(changedBinding.error.code).toBe("CONFLICT");

    const rows = await sql<Array<{ artifact_key: string; file_id: string; protected: boolean }>>`
      SELECT artifact.artifact_key, artifact.file_id::text,
        EXISTS (
          SELECT 1 FROM grids.file_protected_references protected
          WHERE protected.file_id = artifact.file_id
            AND protected.owner_kind = 'document_artifact'
            AND protected.owner_id = artifact.document_id
        ) AS protected
      FROM grids.document_artifacts artifact
      WHERE artifact.document_id = ${issued.data.document.id}::uuid
      ORDER BY artifact.artifact_key
    `;
    expect(rows.map(({ artifact_key, protected: isProtected }) => [artifact_key, isProtected])).toEqual([
      ["pdf", true],
      ["structured", true],
    ]);

    const corruptFileId = testUuid();
    const corruptBytes = new TextEncoder().encode("corrupt");
    await sql`
      INSERT INTO grids.files (id, short_id, filename, mime_type, size_bytes, sha256, bytes)
      VALUES (${corruptFileId}::uuid, ${testShortId("F")}, 'corrupt.bin', 'application/octet-stream', ${corruptBytes.byteLength}, ${"0".repeat(64)}, ${corruptBytes})
    `;
    await sql`
      INSERT INTO grids.file_protected_references (file_id, owner_kind, owner_id, base_id, table_id, record_id)
      VALUES (${corruptFileId}::uuid, 'document_artifact', ${issued.data.document.id}::uuid, ${scope.baseId}::uuid, ${scope.tableId}::uuid, ${scope.recordId}::uuid)
    `;
    await sql`
      INSERT INTO grids.document_artifacts (document_id, artifact_key, file_id)
      VALUES (${issued.data.document.id}::uuid, 'corrupt', ${corruptFileId}::uuid)
    `;
    const corrupt = await service.getDocumentArtifact(issued.data.document.id, "corrupt");
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) expect(corrupt.error.code).toBe("INTERNAL");
  });

  postgresTest("keeps failed receipts frozen and rejects a render/snapshot revision race", async () => {
    const scope = await createScope();
    const created = await createTemplate(
      scope.tableId,
      {
        name: "Retry invoice",
        source: "from table Invoices",
        renderer: {
          kind: "html",
          body: "<p>{{ document.number }}</p>",
          numberTemplate: "RETRY-{{ series.value }}",
          filenameTemplate: "{{ document.number }}.pdf",
        },
      },
      null,
    );
    if (!created.ok) throw created.error;
    const service = createDocumentIssuanceService();
    let failRender = true;
    const input = inputFor(created.data, scope, {
      idempotencyKey: `pending-${testUuid()}`,
      renderPdf: async () => {
        if (failRender) return fail(err.internal("renderer unavailable"));
        return { ok: true, data: { pdf: pdf("recovered"), contentType: "application/pdf" } };
      },
    });
    const failed = await service.issueDocument(input);
    expect(failed.ok).toBe(false);

    const changedActor = await service.issueDocument({ ...input, actor: { kind: "user", userId: testUuid() } });
    expect(changedActor.ok).toBe(false);
    if (!changedActor.ok) expect(changedActor.error.code).toBe("CONFLICT");

    failRender = false;
    const recovered = await service.issueDocument(input);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.data.document.documentNumber).toBe("RETRY-1");

    const raced = await service.issueDocument({
      ...inputFor(created.data, scope, { idempotencyKey: `race-${testUuid()}` }),
      snapshot: {
        ...input.snapshot,
        id: testUuid(),
        root: { ...input.snapshot.root, version: 2 },
        graph: {
          ...input.snapshot.graph,
          records: {
            [`${scope.tableId}:${scope.recordId}`]: { ...input.snapshot.root, version: 2 },
          },
        },
      },
    });
    expect(raced.ok).toBe(false);
    if (!raced.ok) expect(raced.error.code).toBe("CONFLICT");

    const recordBId = testUuid();
    await sql`
      INSERT INTO grids.records (id, short_id, table_id, data, version, updated_at)
      VALUES (${recordBId}::uuid, ${testShortId("R")}, ${scope.tableId}::uuid, '{"content":"B"}'::jsonb, 1, '2026-08-22T10:00:00.000Z')
    `;
    const recordBRoot = { ...input.snapshot.root, id: recordBId, data: { content: "B" } };
    const crossedBinding = await service.issueDocument({
      ...inputFor(created.data, scope, { idempotencyKey: `crossed-binding-${testUuid()}` }),
      snapshot: {
        ...input.snapshot,
        id: testUuid(),
        recordId: recordBId,
        root: recordBRoot,
        graph: {
          rootId: `${scope.tableId}:${recordBId}`,
          records: { [`${scope.tableId}:${recordBId}`]: recordBRoot },
        },
      },
    });
    expect(crossedBinding.ok).toBe(false);
    if (!crossedBinding.ok) expect(crossedBinding.error.code).toBe("CONFLICT");

    const forgedTemplate = await service.issueDocument(
      inputFor({ ...created.data, source: "from table Forged" }, scope, { idempotencyKey: `forged-template-${testUuid()}` }),
    );
    expect(forgedTemplate.ok).toBe(false);
    if (!forgedTemplate.ok) expect(forgedTemplate.error.code).toBe("CONFLICT");

    await sql`
      UPDATE grids.document_templates
      SET source = 'from table Changed', updated_at = updated_at + interval '1 second'
      WHERE id = ${created.data.id}::uuid
    `;
    const staleTemplate = await service.issueDocument(inputFor(created.data, scope, { idempotencyKey: `stale-template-${testUuid()}` }));
    expect(staleTemplate.ok).toBe(false);
    if (!staleTemplate.ok) expect(staleTemplate.error.code).toBe("CONFLICT");

    const freshTemplate = await getTemplate(created.data.id);
    if (!freshTemplate) throw new Error("updated template missing");
    const staleRecordInput = inputFor(freshTemplate, scope, { idempotencyKey: `stale-record-${testUuid()}` });
    await sql`
      UPDATE grids.records SET version = 2, updated_at = updated_at + interval '1 second'
      WHERE id = ${scope.recordId}::uuid
    `;
    const staleRecord = await service.issueDocument(staleRecordInput);
    expect(staleRecord.ok).toBe(false);
    if (!staleRecord.ok) expect(staleRecord.error.code).toBe("CONFLICT");
  });
});
