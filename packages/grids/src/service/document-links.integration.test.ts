import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { insertTestDocumentArtifact } from "../integration-test-utils";
import { migrate } from "../migrate";
import {
  createDocumentLink,
  getDocument,
  listDocumentLinksForDocument,
  recordDocumentLinkAccess,
  resolveDocumentLinkDownload,
  revokeDocumentLink,
} from "./documents";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

type DocumentLinkFixture = {
  baseId: string;
  tableId: string;
  recordId: string;
  snapshotId: string;
  documentId: string;
  artifactFileId: string;
};

const insertFixture = async (): Promise<DocumentLinkFixture> => {
  const baseId = uuid();
  const tableId = uuid();
  const recordId = uuid();
  const snapshotId = uuid();
  const templateId = uuid();
  const documentId = uuid();
  const documentNumber = `INV-${documentId.slice(0, 8)}`;

  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${shortId("B")}, 'Document link integration')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Invoices', 0)
  `;
  await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${recordId}::uuid, ${shortId("R")}, ${tableId}::uuid, '{}'::jsonb)`;
  await sql`
    INSERT INTO grids.document_templates (id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template)
    VALUES (${templateId}::uuid, ${shortId("D")}, ${tableId}::uuid, 'Invoice', 'from table Invoices', 'html', '<p>Invoice</p>', 'INV-{{ series.value }}', '{{ document.number }}.pdf')
  `;
  await sql`
    INSERT INTO grids.record_snapshots (id, short_id, base_id, table_id, record_id, root, graph)
    VALUES (
      ${snapshotId}::uuid,
      ${shortId("S")},
      ${baseId}::uuid,
      ${tableId}::uuid,
      ${recordId}::uuid,
      ${{ id: recordId, tableId, data: { Name: "Invoice 1" } }}::jsonb,
      ${{ rootId: `${tableId}:${recordId}`, records: {} }}::jsonb
    )
  `;
  const artifact = await insertTestDocumentArtifact({ documentId, baseId, tableId, recordId, filename: "invoice-1.pdf" });
  await sql`
    INSERT INTO grids.documents (
      id, short_id, template_id, snapshot_id, base_id, table_id, record_id,
      document_number, filename, tags, template_snapshot, render_data,
      renderer_kind, renderer_version, template_revision, issued_actor
    )
    VALUES (
      ${documentId}::uuid,
      ${shortId("D")},
      ${templateId}::uuid,
      ${snapshotId}::uuid,
      ${baseId}::uuid,
      ${tableId}::uuid,
      ${recordId}::uuid,
      ${documentNumber},
      'invoice-1.pdf',
      '{}'::text[],
      ${{ renderer: { kind: "html", body: "<p>{{ document.number }}</p>", numberTemplate: "INV-{{ series.value }}", filenameTemplate: "{{ document.number }}.pdf" } }}::jsonb,
      ${{ document: { number: documentNumber, createdAt: "2026-07-07T00:00:00.000Z" } }}::jsonb,
      'html', ${artifact.rendererVersion}, ${artifact.templateRevision}, '{"kind":"system"}'::jsonb
    )
  `;
  await artifact.attach();

  return { baseId, tableId, recordId, snapshotId, documentId, artifactFileId: artifact.fileId };
};

const cleanupFixture = async (fixture: DocumentLinkFixture): Promise<void> => {
  void fixture;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("document links integration", () => {
  postgresTest("creates hashed expiring links and rejects revoked links", async () => {
    const fixture = await insertFixture();
    try {
      const document = await getDocument(fixture.documentId);
      if (!document) throw new Error("Fixture Document missing");

      const created = await createDocumentLink({
        document,
        input: { expiresIn: "30d", comment: "Customer copy" },
        actorId: null,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      expect(created.data.token.startsWith("gdl_")).toBe(true);
      expect(created.data.link.comment).toBe("Customer copy");
      expect(new Date(created.data.link.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const [stored] = await sql<Array<{ token_hash: string }>>`
        SELECT token_hash
        FROM grids.document_links
        WHERE id = ${created.data.link.id}::uuid
      `;
      expect(stored?.token_hash).toBeTruthy();
      expect(stored?.token_hash).not.toBe(created.data.token);

      const listed = await listDocumentLinksForDocument(document.id);
      expect(listed.map((link) => link.id)).toContain(created.data.link.id);

      const resolved = await resolveDocumentLinkDownload(created.data.token);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.data.document.id).toBe(document.id);
        expect(resolved.data.link.accessCount).toBe(0);
      }

      const accessed = await recordDocumentLinkAccess(created.data.link.id);
      expect(accessed.ok).toBe(true);
      if (accessed.ok) {
        expect(accessed.data.accessCount).toBe(1);
        expect(accessed.data.lastAccessedAt).toBeTruthy();
      }

      const revoked = await revokeDocumentLink({ linkId: created.data.link.id, actorId: null });
      expect(revoked.ok).toBe(true);
      if (revoked.ok) expect(revoked.data.revokedAt).toBeTruthy();

      const afterRevoke = await resolveDocumentLinkDownload(created.data.token);
      expect(afterRevoke.ok).toBe(false);
      const accessAfterRevoke = await recordDocumentLinkAccess(created.data.link.id);
      expect(accessAfterRevoke.ok).toBe(false);
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
