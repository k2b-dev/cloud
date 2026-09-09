import { beforeAll, describe, expect, test } from "bun:test";
import type { User } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { insertTestDocumentArtifact } from "../integration-test-utils";
import { migrate } from "../migrate";
import { createDocumentsApi } from "./documents";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;

const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

type DocumentLinkApiFixture = {
  baseId: string;
  tableId: string;
  recordId: string;
  snapshotId: string;
  documentId: string;
  documentShortId: string;
  artifactFileId: string;
  accessIds: string[];
};

const testUser = (id: string): User => ({
  id,
  uid: `document-links-${id}`,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "Document",
  sn: "Links",
  displayName: "Document Links",
  mail: `document-links-${id}@example.test`,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
});

const authenticateAs =
  (user: User): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("user", user);
    await next();
  };

const apiFor = (user: User) =>
  new Hono<AuthContext>().route("/documents", createDocumentsApi({ requireAuthenticated: authenticateAs(user) }));

const existingAuthUserId = async (): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    SELECT id::text AS id FROM auth.users ORDER BY id LIMIT 1
  `;
  if (!row) throw new Error("Document links API integration test needs one existing auth.users row");
  return row.id;
};

const insertAccess = async (baseId: string, userId: string, permission: "read" | "write"): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO auth.access (user_id, permission)
    VALUES (${userId}::uuid, ${permission}::auth.permission_level)
    RETURNING id::text AS id
  `;
  if (!row) throw new Error("Failed to create access row");
  await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${row.id}::uuid)`;
  return row.id;
};

const insertFixture = async (userId: string): Promise<DocumentLinkApiFixture> => {
  const baseId = uuid();
  const tableId = uuid();
  const recordId = uuid();
  const snapshotId = uuid();
  const templateId = uuid();
  const documentId = uuid();
  const documentShortId = shortId("D");
  const documentNumber = `INV-API-${documentId.slice(0, 8)}`;

  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${baseId}::uuid, ${shortId("B")}, 'Document links API integration')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES (${tableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Invoices', 0)
  `;
  await sql`
    INSERT INTO grids.records (id, short_id, table_id, data)
    VALUES (${recordId}::uuid, ${shortId("R")}, ${tableId}::uuid, '{}'::jsonb)
  `;
  await sql`
    INSERT INTO grids.document_templates (id, short_id, table_id, name, source, renderer_kind, html, number_template, filename_template)
    VALUES (${templateId}::uuid, ${shortId("T")}, ${tableId}::uuid, 'Invoice', 'from table Invoices', 'html', '<p>Invoice</p>', 'INV-{{ series.value }}', '{{ document.number }}.pdf')
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
  const artifact = await insertTestDocumentArtifact({ documentId, baseId, tableId, recordId, filename: "invoice-api-1.pdf" });
  await sql`
    INSERT INTO grids.documents (
      id, short_id, template_id, snapshot_id, base_id, table_id, record_id,
      document_number, filename, tags, template_snapshot, render_data,
      renderer_kind, renderer_version, template_revision, issued_actor
    )
    VALUES (
      ${documentId}::uuid,
      ${documentShortId},
      ${templateId}::uuid,
      ${snapshotId}::uuid,
      ${baseId}::uuid,
      ${tableId}::uuid,
      ${recordId}::uuid,
      ${documentNumber},
      'invoice-api-1.pdf',
      '{}'::text[],
      ${{ renderer: { kind: "html", body: "<p>{{ document.number }}</p>", numberTemplate: "INV-{{ series.value }}", filenameTemplate: "{{ document.number }}.pdf" } }}::jsonb,
      ${{ document: { id: documentShortId, number: documentNumber, createdAt: "2026-07-07T00:00:00.000Z" } }}::jsonb,
      'html', ${artifact.rendererVersion}, ${artifact.templateRevision}, ${{ kind: "user", userId }}::jsonb
    )
  `;
  await artifact.attach();

  return {
    baseId,
    tableId,
    recordId,
    snapshotId,
    documentId,
    documentShortId,
    artifactFileId: artifact.fileId,
    accessIds: [await insertAccess(baseId, userId, "read")],
  };
};

const cleanupFixture = async (fixture: DocumentLinkApiFixture): Promise<void> => {
  void fixture;
};

const jsonRequest = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("document link API permissions", () => {
  postgresTest("requires document write access to list and create public links", async () => {
    const userId = await existingAuthUserId();
    const app = apiFor(testUser(userId));
    const fixture = await insertFixture(userId);
    try {
      const linksPath = `/documents/${fixture.documentShortId}/links`;
      const readList = await app.request(linksPath);
      expect(readList.status).toBe(403);

      const readCreate = await app.request(linksPath, jsonRequest({ expiresIn: "30d", comment: "Reader should not create links" }));
      expect(readCreate.status).toBe(403);

      fixture.accessIds.push(await insertAccess(fixture.baseId, userId, "write"));

      const writeCreate = await app.request(linksPath, jsonRequest({ expiresIn: "30d", comment: "Writer copy" }));
      expect(writeCreate.status).toBe(201);

      const writeList = await app.request(linksPath);
      expect(writeList.status).toBe(200);
      const listed = (await writeList.json()) as { items: Array<{ comment: string | null }> };
      expect(listed.items.map((link) => link.comment)).toContain("Writer copy");
    } finally {
      await cleanupFixture(fixture);
    }
  });
});
