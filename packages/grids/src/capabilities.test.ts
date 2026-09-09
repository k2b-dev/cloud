import { beforeAll, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { compileCapabilityManifest } from "@valentinkolb/cloud/capabilities/testing";
import {
  CAPABILITY_MAX_RESULT_BYTES,
  type CapabilityActionDefinition,
  CapabilityActionReviewSchema,
  type CapabilityExecutionContext,
  type CapabilityQueryDefinition,
  capabilityResultSchema,
  type User,
} from "@valentinkolb/cloud/contracts";
import { sql } from "bun";
import { PublicDocumentSchema } from "./api/document-public-contracts";
import { gridsCapabilities } from "./capabilities";
import {
  BaseListDataSchema,
  BaseReadInputSchema,
  GqlResultDataSchema,
  RecordCreateInputSchema,
  RecordExternalUpsertInputSchema,
} from "./capability-contracts";
import { migrate } from "./migrate";
import { gridsService } from "./service";
import { enable as enableDurableHistory } from "./service/durable-history";
import { enable as enableFinalization, finalize as finalizeRecord } from "./service/record-finalization";

const zDocument = (value: unknown) => PublicDocumentSchema.omit({ tags: true, createdBy: true }).parse(value);

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;
if (process.env.GRIDS_DB_TEST === "1") setDefaultTimeout(60_000);
const uuid = () => Bun.randomUUIDv7();
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

test("only exposes remembered approval for record updates and external upserts", () => {
  const rememberable = (Object.entries(gridsCapabilities.actions) as Array<[string, CapabilityActionDefinition]>)
    .filter(([, action]) => action.approval === "rememberable")
    .map(([localId]) => localId);
  expect(rememberable).toEqual(["record.upsert-external", "record.update"]);
});

const testUser = (id: string): User => ({
  id,
  uid: `grids-capability-${id}`,
  roles: ["user", "local", "local/user"],
  provider: "local",
  profile: "user",
  givenname: "Grids",
  sn: "Capability",
  displayName: "Grids Capability",
  mail: `grids-capability-${id}@example.test`,
  avatarHash: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
  ipa: null,
});

const userContext = (user: User): CapabilityExecutionContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  user,
  locale: "en",
  signal: new AbortController().signal,
});

const invoke = (kind: "query" | "action", localId: string, input: unknown, context: CapabilityExecutionContext) => {
  const catalog = (kind === "query" ? gridsCapabilities.queries : gridsCapabilities.actions) as unknown as Readonly<
    Record<string, CapabilityQueryDefinition | CapabilityActionDefinition>
  >;
  const operation = catalog[localId];
  if (!operation) throw new Error(`Missing Grids capability ${localId}`);
  const parsed = operation.input.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid test input for ${localId}: ${parsed.error.message}`);
  return Promise.resolve(operation.run(parsed.data, context)).then((result) => {
    if (result.ok) {
      const validated = capabilityResultSchema(operation.data).safeParse(result.data);
      if (!validated.success) throw new Error(`Invalid test result for ${localId}: ${validated.error.message}`);
    }
    return result;
  });
};

const review = (localId: string, input: unknown, context: CapabilityExecutionContext) => {
  const operation = (gridsCapabilities.actions as unknown as Readonly<Record<string, CapabilityActionDefinition>>)[localId];
  if (!operation?.review) throw new Error(`Missing Grids capability review ${localId}`);
  const parsed = operation.input.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid test review input for ${localId}: ${parsed.error.message}`);
  return Promise.resolve(operation.review(parsed.data, context)).then((result) => {
    if (result.ok) {
      const validated = CapabilityActionReviewSchema.safeParse(result.data);
      if (!validated.success) throw new Error(`Invalid test review for ${localId}: ${validated.error.message}`);
      expect(validated.data.approvalScope !== undefined).toBe(operation.approval === "rememberable");
    }
    return result;
  });
};

const existingAuthUserId = async (): Promise<string> => {
  const [row] = await sql<{ id: string }[]>`SELECT id::text AS id FROM auth.users ORDER BY id LIMIT 1`;
  if (!row) throw new Error("Grids capability integration test needs one auth.users row for audit foreign keys");
  return row.id;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("Grids capabilities", () => {
  test("compiles the full additive capability manifest", () => {
    expect(() => compileCapabilityManifest("grids", gridsCapabilities)).not.toThrow();
  });
  test("daily actions require idempotency and individual approval without running reviews", async () => {
    const context = userContext(testUser(uuid()));
    for (const [name, input] of [
      ["document.create", { templateId: "TMPL01", recordId: "REC001" }],
      ["workflow.record-action", { launcherId: "LAUNCH", recordId: "REC001", expectedRevision: 1 }],
    ] as const) {
      expect((await invoke("action", name, input, context)).ok).toBe(false);
      const action = gridsCapabilities.actions[name];
      expect(action.idempotency).toBe("required");
      expect("approval" in action).toBe(false);
      expect(action.review).toBeFunction();
    }
  });
  postgresTest("daily documents retain permissions, bounded discovery, public IDs and durable issuance replay", async () => {
    const user = testUser(await existingAuthUserId());
    const context = userContext(user);
    const outsider = userContext(testUser(uuid()));
    const baseId = uuid();
    const tableId = uuid();
    const recordId = uuid();
    const otherRecordId = uuid();
    const basePublicId = shortId("B");
    const tablePublicId = shortId("T");
    const recordPublicId = shortId("R");
    const otherPublicId = shortId("R");
    let accessId: string | undefined;
    const issue = gridsService.document.createDocumentForRecord;
    const renderer = spyOn(gridsService.document, "createDocumentForRecord").mockImplementation((input) =>
      issue({
        ...input,
        renderPdf: async () => ({
          ok: true,
          data: { pdf: new TextEncoder().encode("%PDF-1.7\ntest artifact"), contentType: "application/pdf" },
        }),
      }),
    );
    try {
      await sql`INSERT INTO grids.bases (id,short_id,name) VALUES (${baseId}::uuid,${basePublicId},'Daily capability')`;
      await sql`INSERT INTO grids.tables (id,short_id,base_id,name) VALUES (${tableId}::uuid,${tablePublicId},${baseId}::uuid,'TestDocs')`;
      await sql`INSERT INTO grids.records (id,short_id,table_id,data,version) VALUES (${recordId}::uuid,${recordPublicId},${tableId}::uuid,'{}'::jsonb,1),(${otherRecordId}::uuid,${otherPublicId},${tableId}::uuid,'{}'::jsonb,1)`;
      const [access] = await sql<
        { id: string }[]
      >`INSERT INTO auth.access (user_id,permission) VALUES (${user.id}::uuid,'write'::auth.permission_level) RETURNING id`;
      accessId = access!.id;
      await sql`INSERT INTO grids.base_access (base_id,access_id) VALUES (${baseId}::uuid,${accessId}::uuid)`;
      const created = await gridsService.document.createTemplate(
        tableId,
        {
          name: "Receipt",
          source: "from table TestDocs",
          renderer: {
            kind: "html",
            body: "<p>{{ document.number }}</p>",
            numberTemplate: "DOC-{{ series.value }}",
            filenameTemplate: "{{ document.number }}.pdf",
          },
        },
        user.id,
      );
      if (!created.ok) throw created.error;
      const templateId = created.data.shortId;
      const input = { templateId, recordId: recordPublicId };
      expect((await invoke("query", "document.templates", { tableId: tablePublicId }, outsider)).ok).toBe(false);
      expect((await review("document.create", input, outsider)).ok).toBe(false);
      const found = await invoke("query", "document.templates", { tableId: tablePublicId, limit: 1 }, context);
      expect(found.ok && found.data.data).toEqual({
        items: [{ id: templateId, tableId: tablePublicId, name: "Receipt", enabled: true }],
        nextOffset: null,
      });
      const reviewed = await review("document.create", input, { ...context, locale: "de" });
      expect(reviewed.ok && reviewed.data.message).toContain("dauerhaftes Dokument");
      expect(renderer).not.toHaveBeenCalled();
      const keyed = { ...context, idempotencyKey: "same-request" };
      const first = await invoke("action", "document.create", input, keyed);
      if (!first.ok) throw first.error;
      const again = await invoke("action", "document.create", input, keyed);
      expect(again).toEqual(first);
      const document = zDocument(first.data.data);
      const read = await invoke("query", "document.read", { id: document.id }, context);
      expect(read).toEqual(first);
      expect((await invoke("query", "document.read", { id: document.id }, outsider)).ok).toBe(false);
      expect(JSON.stringify(first)).not.toContain(tableId);
      expect(JSON.stringify(first)).not.toContain(recordId);
      const page = await invoke("query", "document.list", { templateId, limit: 1 }, context);
      expect(page.ok && page.data.data).toEqual([document]);
      expect((await invoke("query", "document.list", { templateId, cursor: "garbage" }, context)).ok).toBe(false);
      expect((await invoke("action", "document.create", { ...input, recordId: otherPublicId }, keyed)).ok).toBe(false);
      expect((await invoke("query", "workflow.record-actions", { baseId: basePublicId }, outsider)).ok).toBe(false);
      const actions = await invoke("query", "workflow.record-actions", { baseId: basePublicId, limit: 1 }, context);
      expect(actions.ok && actions.data.data).toEqual({ items: [], nextOffset: null });
      await sql`INSERT INTO grids.fields (id,short_id,table_id,name,type,config) VALUES (${uuid()}::uuid,${shortId("F")},${tableId}::uuid,'Name','text','{}'::jsonb)`;
      await sql`INSERT INTO grids.fields (id,short_id,table_id,name,type,config) VALUES (${uuid()}::uuid,${shortId("F")},${tableId}::uuid,'Corrects','relation',${{ targetTableId: tableId, cardinality: "single" }}::jsonb)`;
      expect((await enableDurableHistory(tableId, user.id)).ok).toBe(true);
      expect((await enableFinalization(tableId, { mode: "direct" }, user.id)).ok).toBe(true);
      expect((await finalizeRecord({ tableId, recordId, actorId: user.id, origin: "direct" })).ok).toBe(true);
      const workflow = await gridsService.workflow.create(
        baseId,
        {
          name: "Review record",
          enabled: true,
          source:
            "inputs:\n  item:\n    type: record\n    table: TestDocs\n    required: true\nsteps:\n  - createCorrectionDraft:\n      original: inputs.item\n      intent: correction\n      typeField: Name\n      typeValue: correction\n      originalField: Corrects",
        },
        user.id,
      );
      if (!workflow.ok) throw workflow.error;
      const launcher = await gridsService.workflow.launcher.create(
        workflow.data,
        { name: "Review record", enabled: true, config: { kind: "record", input: "item", profile: "correctionDraft" } },
        user.id,
      );
      if (!launcher.ok) throw launcher.error;
      const discoveredActions = await invoke("query", "workflow.record-actions", { baseId: basePublicId, limit: 1 }, context);
      expect(discoveredActions.ok && discoveredActions.data.data).toEqual({
        items: [
          {
            id: launcher.data.shortId,
            name: "Review record",
            tableId: tablePublicId,
            expectedRevision: workflow.data.revision,
            intent: "correction",
          },
        ],
        nextOffset: null,
      });
      const actionInput = { launcherId: launcher.data.shortId, recordId: recordPublicId, expectedRevision: workflow.data.revision };
      expect((await review("workflow.record-action", actionInput, outsider)).ok).toBe(false);
      const actionReview = await review("workflow.record-action", actionInput, context);
      expect(actionReview.ok).toBe(true);
      expect((await review("workflow.record-action", { ...actionInput, expectedRevision: workflow.data.revision + 1 }, context)).ok).toBe(
        false,
      );
      const executed = await invoke("action", "workflow.record-action", actionInput, keyed);
      if (!executed.ok) throw executed.error;
      const runId = executed.data.refs?.[0]?.id;
      expect(runId).toMatch(/^[A-Za-z0-9]{6}$/);
      const repeated = await invoke("action", "workflow.record-action", actionInput, keyed);
      expect(repeated.ok && repeated.data.refs?.[0]?.id).toBe(runId);
      const runStatus = await invoke("query", "workflow.run.read", { id: runId }, context);
      expect(runStatus.ok).toBe(true);
      expect((await invoke("query", "workflow.run.read", { id: runId }, outsider)).ok).toBe(false);
      expect(JSON.stringify(runStatus)).not.toContain(recordId);
      expect((await invoke("action", "workflow.record-action", { ...actionInput, recordId: otherPublicId }, keyed)).ok).toBe(false);
      await sql`DELETE FROM grids.base_access WHERE base_id=${baseId}::uuid`;
      expect((await invoke("action", "document.create", input, keyed)).ok).toBe(false);
      expect((await invoke("query", "document.read", { id: document.id }, context)).ok).toBe(false);
    } finally {
      renderer.mockRestore();
      // Issuance fixtures are immutable too; hide their Base instead of bypassing its retention constraints.
      await sql`UPDATE grids.bases SET deleted_at=now() WHERE id=${baseId}::uuid`;
      if (accessId) await sql`DELETE FROM auth.access WHERE id=${accessId}::uuid`;
    }
  });
  test("declares the curated v1 surface", () => {
    expect(gridsCapabilities.protocolVersion).toBe(1);
    expect(Object.keys(gridsCapabilities.types ?? {}).sort()).toEqual(["base", "document", "record", "table", "view", "workflow-run"]);
    expect(Object.keys(gridsCapabilities.queries ?? {}).sort()).toEqual([
      "base.list",
      "base.read",
      "base.search",
      "document.list",
      "document.read",
      "document.templates",
      "gql.context",
      "gql.execute",
      "gql.preview",
      "gql.view.execute",
      "record.read",
      "table.read",
      "view.read",
      "workflow.record-actions",
      "workflow.run.read",
    ]);
    expect(Object.keys(gridsCapabilities.actions ?? {}).sort()).toEqual([
      "document.create",
      "record.create",
      "record.update",
      "record.upsert-external",
      "view.create",
      "workflow.record-action",
    ]);
    expect(
      Object.entries(gridsCapabilities.actions ?? {})
        .filter(([, action]) => "review" in action && action.review)
        .map(([id]) => id),
    ).toEqual(["document.create", "workflow.record-action", "view.create", "record.upsert-external", "record.update"]);
    expect(gridsCapabilities.queries?.["base.list"]?.description).toContain("Normal entry for Base-scoped Grids work");
    expect(gridsCapabilities.queries?.["gql.context"]?.description).toContain("request tables first");
    expect(gridsCapabilities.queries?.["gql.execute"]?.description).toContain("normally gql.preview");
    expect(gridsCapabilities.queries?.["gql.view.execute"]?.description).toContain("direct saved-view path");
  });

  test("accepts semantic links on navigable list and query rows", () => {
    const baseId = "Base01";
    const tableId = "Table1";
    const recordId = "Rec001";
    const links = [{ rel: "open" as const, href: `/app/grids/base/table/table?record=${recordId}` }];
    expect(
      BaseListDataSchema.safeParse([
        {
          id: baseId,
          name: "Base",
          description: null,
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
          links,
        },
      ]).success,
    ).toBeTrue();
    expect(
      GqlResultDataSchema.safeParse({
        ok: true,
        mode: "rows",
        columns: [],
        rows: [{ recordId, tableId, values: {}, links }],
        limit: 1,
      }).success,
    ).toBeTrue();
  });

  test("accepts only strict public IDs at the capability boundary", () => {
    expect(BaseReadInputSchema.safeParse({ id: "Base01" }).success).toBeTrue();
    expect(BaseReadInputSchema.safeParse({ id: "Base1" }).success).toBeFalse();
    expect(BaseReadInputSchema.safeParse({ id: uuid() }).success).toBeFalse();
    expect(RecordCreateInputSchema.safeParse({ tableId: "Table1", values: { Field1: "value" } }).success).toBeTrue();
    expect(RecordCreateInputSchema.safeParse({ tableId: "Table1", values: { [uuid()]: "value" } }).success).toBeFalse();
    expect(
      RecordExternalUpsertInputSchema.safeParse({
        tableId: "Table1",
        externalRef: { provider: "crm", providerAccount: "main", resourceKind: "contact", externalId: "003ABC" },
        values: { Field1: "value" },
      }).success,
    ).toBeTrue();
    expect(
      RecordExternalUpsertInputSchema.safeParse({
        tableId: "Table1",
        externalRef: { provider: " crm", providerAccount: "main", resourceKind: "contact", externalId: "003ABC" },
        values: { Field1: "value" },
      }).success,
    ).toBeFalse();
    for (const part of ["provider", "providerAccount", "resourceKind", "externalId"] as const) {
      const externalRef = { provider: "crm", providerAccount: "main", resourceKind: "contact", externalId: "003ABC" };
      expect(
        RecordExternalUpsertInputSchema.safeParse({
          tableId: "Table1",
          externalRef: { ...externalRef, [part]: `${externalRef[part]}\0x` },
          values: { Field1: "value" },
        }).success,
      ).toBeFalse();
    }
    expect(
      BaseListDataSchema.safeParse([
        {
          id: "Base01",
          shortId: "Base01",
          name: "Base",
          description: null,
          createdAt: "2026-08-04T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
        },
      ]).success,
    ).toBeFalse();
  });

  postgresTest("discovers schema, executes GQL, and mutates records with conflict protection", async () => {
    process.env.APP_SECRET ??= "grids-capability-integration-secret";
    const user = testUser(await existingAuthUserId());
    const context = userContext(user);
    const baseId = uuid();
    const tableId = uuid();
    const secretTableId = uuid();
    const viewId = uuid();
    const fieldId = uuid();
    const selectFieldId = uuid();
    const relationFieldId = uuid();
    const singleRelationFieldId = uuid();
    const auditQuestionId = uuid();
    const auditOptionId = uuid();
    const basePublicId = shortId("B");
    const tablePublicId = shortId("T");
    const secretTablePublicId = shortId("S");
    const viewPublicId = shortId("V");
    const fieldPublicId = shortId("F");
    const selectFieldPublicId = shortId("O");
    const relationFieldPublicId = shortId("R");
    const singleRelationFieldPublicId = shortId("Q");
    const accessIds: string[] = [];

    try {
      await sql`INSERT INTO grids.bases (id, short_id, name, description) VALUES (${baseId}::uuid, ${basePublicId}, 'Capability Base', 'Agent data')`;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES
          (${tableId}::uuid, ${tablePublicId}, ${baseId}::uuid, 'Items', 0),
          (${secretTableId}::uuid, ${secretTablePublicId}, ${baseId}::uuid, 'Secret items', 1)
      `;
      await sql`
        UPDATE grids.tables
        SET audit_policy = ${{
          update: {
            enabled: true,
            scope: "selected",
            fieldIds: [selectFieldId],
            questions: [
              {
                id: auditQuestionId,
                label: "Change reason",
                description: "Explain why the status changed.",
                type: "select",
                required: true,
                options: [{ id: auditOptionId, label: "Reviewed" }],
              },
            ],
          },
        }}::jsonb
        WHERE id = ${tableId}::uuid
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES
          (${fieldId}::uuid, ${fieldPublicId}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0),
          (${selectFieldId}::uuid, ${selectFieldPublicId}, ${tableId}::uuid, 'Status', 'select', ${{
            multiple: false,
            options: [
              { id: "open", label: "Open", description: "Work has started." },
              { id: "done", label: "Done", description: "Work is complete." },
            ],
          }}::jsonb, 1),
          (${relationFieldId}::uuid, ${relationFieldPublicId}, ${tableId}::uuid, 'Secret relations', 'relation', ${{
            targetTableId: secretTableId,
            cardinality: "multiple",
          }}::jsonb, 2),
          (${singleRelationFieldId}::uuid, ${singleRelationFieldPublicId}, ${tableId}::uuid, 'Primary secret relation', 'relation', ${{
            targetTableId: secretTableId,
            cardinality: "single",
          }}::jsonb, 3)
      `;
      await sql`
        INSERT INTO grids.views (id, short_id, table_id, name, source, ui, position)
        VALUES (${viewId}::uuid, ${viewPublicId}, ${tableId}::uuid, 'All items', ${`from table {${tablePublicId}}`}, '{}'::jsonb, 0)
      `;
      const [access] = await sql<{ id: string }[]>`
        INSERT INTO auth.access (user_id, permission)
        VALUES (${user.id}::uuid, 'write'::auth.permission_level)
        RETURNING id::text AS id
      `;
      if (!access) throw new Error("Failed to create Grids capability access fixture");
      accessIds.push(access.id);
      await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access.id}::uuid)`;

      const search = await invoke("query", "base.search", { query: "Capability", tags: [], limit: 10 }, context);
      expect(search.ok && search.data.data).toEqual([
        expect.objectContaining({ ref: { type: "grids.base", id: basePublicId }, title: "Capability Base" }),
      ]);

      const listed = await invoke("query", "base.list", { query: "Capability", limit: 25 }, context);
      expect(listed.ok && listed.data.data).toEqual([
        expect.objectContaining({
          id: basePublicId,
          name: "Capability Base",
          links: [{ rel: "open", href: expect.stringMatching(/^\/app\/grids\//) }],
        }),
      ]);

      const loadedBase = await invoke("query", "base.read", { id: basePublicId }, context);
      expect(loadedBase.ok && loadedBase.data.data).toMatchObject({ id: basePublicId });
      if (loadedBase.ok) {
        expect(loadedBase.data.data).not.toHaveProperty("shortId");
        expect(loadedBase.data.summary).toBe("Read Grids Base “Capability Base”.");
      }

      const tables = await invoke("query", "gql.context", { baseId: basePublicId, kind: "tables", limit: 25 }, context);
      expect(tables.ok && tables.data.data).toMatchObject({ kind: "tables" });
      if (!tables.ok || tables.data.data.kind !== "tables") throw new Error("Expected the Base table catalog");
      expect(tables.data.data.items.find((item: { id: string }) => item.id === tablePublicId)).toMatchObject({
        kind: "table",
        id: tablePublicId,
        name: "Items",
        tableKind: "stored",
      });
      expect(tables.data.data.items.find((item: { id: string }) => item.id === secretTablePublicId)).toMatchObject({
        kind: "table",
        id: secretTablePublicId,
        name: "Secret items",
      });
      expect(tables.data.data.base).toEqual({ id: basePublicId, name: "Capability Base" });
      expect(tables.data.data.items[0]).not.toHaveProperty("permission");
      expect(tables.data.data).not.toHaveProperty("recordWrite");
      const loadedTable = await invoke("query", "table.read", { id: tablePublicId }, context);
      expect(loadedTable.ok && loadedTable.data.summary).toBe("Read Grids Table “Items”.");

      const readFields = await invoke("query", "gql.context", { baseId: basePublicId, kind: "fields", tableId: tablePublicId }, context);
      expect(readFields.ok).toBeTrue();
      if (readFields.ok) {
        expect(readFields.data.data).not.toHaveProperty("recordWrite");
        expect(readFields.data.data.items[0]).not.toHaveProperty("writable");
        expect(readFields.data.data.items[0]).not.toHaveProperty("required");
        expect(readFields.data.data.items[0]).not.toHaveProperty("position");
      }

      const fields = await invoke(
        "query",
        "gql.context",
        { baseId: basePublicId, kind: "fields", tableId: tablePublicId, limit: 25, includeWriteContext: true },
        context,
      );
      expect(fields.ok && fields.data.data).toMatchObject({
        kind: "fields",
        items: [
          { kind: "field", id: fieldPublicId, name: "Name", writable: true, valueHint: expect.stringContaining("String") },
          { kind: "field", id: selectFieldPublicId, name: "Status", writable: true, valueHint: expect.stringContaining("option IDs") },
          {
            kind: "field",
            id: relationFieldPublicId,
            name: "Secret relations",
            writable: true,
            targetTableId: secretTablePublicId,
            relationCardinality: "multiple",
          },
          {
            kind: "field",
            id: singleRelationFieldPublicId,
            name: "Primary secret relation",
            writable: true,
            targetTableId: secretTablePublicId,
            relationCardinality: "single",
          },
        ],
        recordWrite: {
          tableId: tablePublicId,
          canCreateRecords: true,
          canUpdateRecords: true,
          updateAudit: {
            scope: "selected",
            fieldIds: [selectFieldPublicId],
            questions: [
              {
                id: auditQuestionId,
                label: "Change reason",
                description: "Explain why the status changed.",
                type: "select",
                required: true,
                options: [{ id: auditOptionId, label: "Reviewed" }],
              },
            ],
          },
        },
      });

      const options = await invoke(
        "query",
        "gql.context",
        { baseId: basePublicId, kind: "options", tableId: tablePublicId, fieldId: selectFieldPublicId, limit: 1 },
        context,
      );
      expect(options.ok && options.data.data).toMatchObject({
        kind: "options",
        items: [{ kind: "option", id: "open", fieldId: selectFieldPublicId, label: "Open", description: "Work has started." }],
      });
      if (!options.ok || !options.data.page?.hasMore) throw new Error("Expected a second select-option page");
      const nextCursor = options.data.page.nextCursor;
      const remainingOptions = await invoke(
        "query",
        "gql.context",
        {
          baseId: basePublicId,
          kind: "options",
          tableId: tablePublicId,
          fieldId: selectFieldPublicId,
          limit: 1,
          cursor: nextCursor,
        },
        context,
      );
      expect(remainingOptions.ok && remainingOptions.data.data).toMatchObject({
        kind: "options",
        items: [{ kind: "option", id: "done", fieldId: selectFieldPublicId, label: "Done" }],
      });

      const views = await invoke("query", "gql.context", { baseId: basePublicId, kind: "views", limit: 25 }, context);
      expect(views.ok && views.data.data).toMatchObject({
        kind: "views",
        items: [{ kind: "view", id: viewPublicId, name: "All items" }],
      });
      const loadedView = await invoke("query", "view.read", { id: viewPublicId }, context);
      expect(loadedView.ok && loadedView.data.summary).toBe("Read Grids View “All items”.");

      const created = await invoke("action", "record.create", { tableId: tablePublicId, values: { [fieldPublicId]: "First" } }, context);
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      const record = created.data.data as { id: string; version: number };
      expect(record.id).toMatch(/^[A-Za-z0-9]{6}$/);
      expect(record.version).toBe(1);
      expect(created.data.summary).toBe(`Created Record ${record.id} in “Items”.`);
      expect(record).not.toHaveProperty("data");

      const externalInput = {
        tableId: tablePublicId,
        externalRef: { provider: "crm", providerAccount: "main", resourceKind: "contact", externalId: "capability-1" },
        values: { [fieldPublicId]: "External capability" },
      };
      const externalContext = { ...context, idempotencyKey: "external-capability-create" };
      const externalCreated = await invoke("action", "record.upsert-external", externalInput, externalContext);
      expect(externalCreated).toMatchObject({
        ok: true,
        data: { data: { created: true, changed: true, replayed: false, tableId: tablePublicId, version: 1 } },
      });
      const externalRetry = await invoke("action", "record.upsert-external", externalInput, externalContext);
      expect(externalRetry).toMatchObject({
        ok: true,
        data: { data: { created: true, changed: true, replayed: true, tableId: tablePublicId, version: 1 } },
      });
      const externalMismatch = await invoke(
        "action",
        "record.upsert-external",
        { ...externalInput, values: { [fieldPublicId]: "Different request" } },
        externalContext,
      );
      expect(externalMismatch).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT", status: 409 } });
      const externalScopeMismatch = await invoke(
        "action",
        "record.upsert-external",
        { ...externalInput, externalRef: { ...externalInput.externalRef, providerAccount: "secondary" } },
        externalContext,
      );
      expect(externalScopeMismatch).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT", status: 409 } });
      if (!externalCreated.ok) throw new Error("Expected external Record capability create");
      const externalUpdated = await invoke(
        "action",
        "record.upsert-external",
        { ...externalInput, values: { [fieldPublicId]: "External capability updated" }, ifVersion: 1 },
        { ...context, idempotencyKey: "external-capability-update" },
      );
      expect(externalUpdated).toMatchObject({
        ok: true,
        data: { data: { created: false, changed: true, replayed: false, version: 2 } },
      });
      const externalOldReplay = await invoke("action", "record.upsert-external", externalInput, externalContext);
      expect(externalOldReplay).toMatchObject({
        ok: true,
        data: { data: { created: true, changed: true, replayed: true, version: 1 } },
      });

      const loadedRecord = await invoke("query", "record.read", { id: record.id }, context);
      expect(loadedRecord.ok && loadedRecord.data.data).toMatchObject({ id: record.id, version: 1 });
      if (loadedRecord.ok) {
        expect(loadedRecord.data.data).not.toHaveProperty("data");
        expect(loadedRecord.data.summary).toBe("Read a Record in “Items” at version 1.");
      }
      const relatedA = await invoke("action", "record.create", { tableId: secretTablePublicId, values: {} }, context);
      const relatedB = await invoke("action", "record.create", { tableId: secretTablePublicId, values: {} }, context);
      if (!relatedA.ok || !relatedB.ok) throw new Error("Expected related Record fixtures");
      const relatedAId = relatedA.data.data.id;
      const relatedBId = relatedB.data.data.id;

      const relationCreated = await invoke(
        "action",
        "record.create",
        {
          tableId: tablePublicId,
          values: {
            [relationFieldPublicId]: [relatedAId, relatedBId],
            [singleRelationFieldPublicId]: relatedAId,
          },
        },
        context,
      );
      expect(relationCreated).toMatchObject({ ok: true, data: { data: { version: 1 } } });
      if (!relationCreated.ok) throw new Error(relationCreated.error.message);

      const relationUpdated = await invoke(
        "action",
        "record.update",
        {
          tableId: tablePublicId,
          recordId: relationCreated.data.data.id,
          values: {
            [relationFieldPublicId]: [relatedBId],
            [singleRelationFieldPublicId]: relatedBId,
          },
          ifVersion: 1,
        },
        context,
      );
      expect(relationUpdated.ok && relationUpdated.data.data).toMatchObject({ version: 2 });
      if (relationUpdated.ok) {
        expect(relationUpdated.data.summary).toBe(
          `Updated 2 Fields on Record ${relationCreated.data.data.id} in “Items”; the Record is now version 2.`,
        );
      }

      const [relatedInternal] = await sql<{ id: string }[]>`
        SELECT id::text AS id FROM grids.records WHERE short_id = ${relatedAId}
      `;
      if (!relatedInternal) throw new Error("Expected related Record internal fixture");
      const rejectedUuidRelation = await invoke(
        "action",
        "record.create",
        { tableId: tablePublicId, values: { [relationFieldPublicId]: [relatedInternal.id] } },
        context,
      );
      expect(rejectedUuidRelation).toMatchObject({ ok: false, error: { code: "BAD_INPUT", status: 400 } });
      const rejectedFiveCharacterRelation = await invoke(
        "action",
        "record.create",
        { tableId: tablePublicId, values: { [singleRelationFieldPublicId]: "Ab123" } },
        context,
      );
      expect(rejectedFiveCharacterRelation).toMatchObject({ ok: false, error: { code: "BAD_INPUT", status: 400 } });
      const rejectedUnknownRelation = await invoke(
        "action",
        "record.create",
        { tableId: tablePublicId, values: { [singleRelationFieldPublicId]: "ZZZZZZ" } },
        context,
      );
      expect(rejectedUnknownRelation).toMatchObject({ ok: false, error: { code: "BAD_INPUT", status: 400 } });

      const relationQuery = await invoke(
        "query",
        "gql.execute",
        {
          baseId: basePublicId,
          query: `from table {${tablePublicId}}\nselect {${relationFieldPublicId}}, {${singleRelationFieldPublicId}}\nwhere record.id = '${relationCreated.data.data.id}'`,
          pageSize: 25,
        },
        context,
      );
      expect(relationQuery.ok).toBe(true);
      if (!relationQuery.ok || !relationQuery.data.data.ok) throw new Error("Expected relation GQL rows");
      const relationColumn = relationQuery.data.data.columns.find(
        (column: { fieldId?: string; key: string }) => column.fieldId === relationFieldPublicId,
      );
      const singleRelationColumn = relationQuery.data.data.columns.find(
        (column: { fieldId?: string; key: string }) => column.fieldId === singleRelationFieldPublicId,
      );
      if (!relationColumn || !singleRelationColumn) throw new Error("Expected both relation GQL columns");
      expect(relationQuery.data.data.rows[0]?.values[relationColumn.key]).toEqual([relatedBId]);
      expect(relationQuery.data.data.rows[0]?.values[singleRelationColumn.key]).toEqual([relatedBId]);

      const groupedRelationQuery = await invoke(
        "query",
        "gql.execute",
        {
          baseId: basePublicId,
          query: `from table {${tablePublicId}}\ngroup by {${relationFieldPublicId}}\naggregate count(*) as records`,
          pageSize: 25,
        },
        context,
      );
      expect(groupedRelationQuery.ok).toBe(true);
      if (!groupedRelationQuery.ok || !groupedRelationQuery.data.data.ok) throw new Error("Expected grouped relation GQL rows");
      const groupedRelationColumn = groupedRelationQuery.data.data.columns.find(
        (column: { fieldId?: string; key: string }) => column.fieldId === relationFieldPublicId,
      );
      if (!groupedRelationColumn) throw new Error("Expected grouped relation GQL column");
      expect(groupedRelationColumn).not.toHaveProperty("sqlType");
      expect(
        groupedRelationQuery.data.data.rows.map((row: { values: Record<string, unknown> }) => row.values[groupedRelationColumn.key]),
      ).toEqual([relatedBId]);

      const preview = await invoke(
        "query",
        "gql.preview",
        { baseId: basePublicId, query: `from table {${tablePublicId}}\nselect {${fieldPublicId}}`, pageSize: 25 },
        context,
      );
      expect(preview.ok).toBe(true);
      if (!preview.ok || !preview.data.data.ok) throw new Error("Expected preview GQL rows");
      const previewColumn = preview.data.data.columns.find(
        (column: { fieldId?: string; key: string; tableId?: string }) => column.fieldId === fieldPublicId,
      );
      const previewRow = preview.data.data.rows.find(
        (row: { recordId?: string; tableId?: string; values: Record<string, unknown>; links?: Array<{ href: string }> }) =>
          row.recordId === record.id,
      );
      if (!previewColumn || !previewRow) throw new Error("Expected the created Record in the GQL preview");
      expect(previewColumn.tableId).toBe(tablePublicId);
      expect(previewRow.tableId).toBe(tablePublicId);
      expect(previewRow.values[previewColumn.key]).toBe("First");
      expect(previewRow).not.toHaveProperty("recordMeta");
      expect(previewColumn).not.toHaveProperty("sqlType");
      expect(preview.data.refs).toContainEqual(expect.objectContaining({ type: "grids.record", id: record.id, title: "First" }));
      expect(previewRow.links?.[0]?.href).toContain(`record=${record.id}`);
      expect(preview.data.summary).toContain("Previewed Grids GQL in “Capability Base”");
      expect(preview.data.presentation).toMatchObject({ kind: "table", rowsPath: ["rows"], rowLinksPath: ["links"] });
      expect(preview.data.links?.[0]?.href).toContain("/query?q=");

      const statusOnly = await invoke(
        "query",
        "gql.preview",
        {
          baseId: basePublicId,
          query: `from table {${tablePublicId}}\nselect {${selectFieldPublicId}}\nwhere record.id = '${record.id}'`,
        },
        context,
      );
      expect(statusOnly.ok).toBeTrue();
      if (statusOnly.ok) {
        expect(statusOnly.data.refs).toContainEqual(expect.objectContaining({ type: "grids.record", id: record.id, title: "First" }));
        expect(statusOnly.data.data.rows[0].values).not.toHaveProperty(fieldPublicId);
      }

      const gql = await invoke(
        "query",
        "gql.execute",
        { baseId: basePublicId, query: `from table {${tablePublicId}}\nselect {${fieldPublicId}}`, pageSize: 100 },
        context,
      );
      expect(gql.ok && gql.data.data.ok && gql.data.data.rows.some((row: { recordId?: string }) => row.recordId === record.id)).toBe(true);
      if (gql.ok) expect(gql.data.summary).toContain("Executed Grids GQL in “Capability Base”");

      const savedView = await invoke("query", "gql.view.execute", { baseId: basePublicId, viewId: viewPublicId, pageSize: 100 }, context);
      expect(
        savedView.ok && savedView.data.data.ok && savedView.data.data.rows.some((row: { recordId?: string }) => row.recordId === record.id),
      ).toBe(true);
      if (savedView.ok) expect(savedView.data.summary).toContain("Executed saved Grids View “All items”");

      const missingAudit = await invoke(
        "action",
        "record.update",
        {
          tableId: tablePublicId,
          recordId: record.id,
          values: { [selectFieldPublicId]: ["open"] },
          ifVersion: record.version,
        },
        context,
      );
      expect(missingAudit).toMatchObject({ ok: false, error: { code: "BAD_INPUT", status: 400 } });

      const statusUpdated = await invoke(
        "action",
        "record.update",
        {
          tableId: tablePublicId,
          recordId: record.id,
          values: { [selectFieldPublicId]: ["open"] },
          ifVersion: record.version,
          audit: { answers: { [auditQuestionId]: auditOptionId } },
        },
        context,
      );
      expect(statusUpdated.ok && statusUpdated.data.data).toMatchObject({ version: 2 });
      if (statusUpdated.ok) expect(statusUpdated.data.data).not.toHaveProperty("data");
      if (!statusUpdated.ok) throw new Error(statusUpdated.error.message);

      const updated = await invoke(
        "action",
        "record.update",
        {
          tableId: tablePublicId,
          recordId: record.id,
          values: { [fieldPublicId]: "Second" },
          ifVersion: statusUpdated.data.data.version,
        },
        context,
      );
      expect(updated.ok && updated.data.data).toMatchObject({ version: 3 });
      if (updated.ok) expect(updated.data.data).not.toHaveProperty("data");

      const stale = await invoke(
        "action",
        "record.update",
        { tableId: tablePublicId, recordId: record.id, values: { [fieldPublicId]: "Stale" }, ifVersion: record.version },
        context,
      );
      expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT", status: 409 } });

      const largeCreated = await invoke(
        "action",
        "record.create",
        { tableId: tablePublicId, values: { [fieldPublicId]: "x".repeat(261_800) } },
        context,
      );
      expect(largeCreated.ok).toBe(true);
      if (!largeCreated.ok) throw new Error(largeCreated.error.message);
      expect(largeCreated.data.data).not.toHaveProperty("data");
      expect(new TextEncoder().encode(JSON.stringify(largeCreated.data)).byteLength).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);

      const oversizedRow = await invoke(
        "query",
        "gql.execute",
        {
          baseId: basePublicId,
          query: `from table {${tablePublicId}}\nselect {${fieldPublicId}}\nwhere record.id = '${largeCreated.data.data.id}'`,
          pageSize: 100,
        },
        context,
      );
      expect(oversizedRow).toMatchObject({
        ok: false,
        error: { code: "BAD_INPUT", message: expect.stringContaining("Select fewer fields") },
      });

      await sql`
        INSERT INTO grids.records (id, short_id, table_id, data)
        SELECT gen_random_uuid(), substring(md5(random()::text) FROM 1 FOR 6), ${tableId}::uuid,
               jsonb_build_object(${fieldId}::text, 'page-' || item::text || repeat('x', 10000))
        FROM generate_series(1, 30) AS item
      `;
      const pagedQuery = `from table {${tablePublicId}}\nselect {${fieldPublicId}}\nwhere contains({${fieldPublicId}}, 'page-')`;
      const firstPage = await invoke("query", "gql.execute", { baseId: basePublicId, query: pagedQuery, pageSize: 100 }, context);
      expect(firstPage.ok).toBe(true);
      if (!firstPage.ok || !firstPage.data.page?.hasMore) throw new Error("Expected a byte-bounded first GQL page");
      expect(new TextEncoder().encode(JSON.stringify(firstPage.data)).byteLength).toBeLessThan(CAPABILITY_MAX_RESULT_BYTES);
      const firstIds = (firstPage.data.data.ok ? firstPage.data.data.rows : []).flatMap((row: { recordId?: string }) =>
        row.recordId ? [row.recordId] : [],
      );
      const secondPage = await invoke(
        "query",
        "gql.execute",
        { baseId: basePublicId, query: pagedQuery, pageSize: 100, cursor: firstPage.data.page.nextCursor },
        context,
      );
      expect(secondPage.ok).toBe(true);
      if (!secondPage.ok) throw new Error(secondPage.error.message);
      const secondIds = (secondPage.data.data.ok ? secondPage.data.data.rows : []).flatMap((row: { recordId?: string }) =>
        row.recordId ? [row.recordId] : [],
      );
      expect(new Set([...firstIds, ...secondIds]).size).toBe(30);
      expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);

      const reviewInput = { [fieldPublicId]: "changed" };
      const updateReview = await review(
        "record.update",
        { tableId: tablePublicId, recordId: record.id, values: reviewInput, ifVersion: 3 },
        context,
      );
      const externalReview = await review("record.upsert-external", externalInput, context);
      expect(externalReview).toMatchObject({ ok: true, data: { approvalScope: `table:${tablePublicId}` } });
      expect(updateReview.ok).toBe(true);
      expect(updateReview).toMatchObject({ ok: true, data: { approvalScope: `table:${tablePublicId}` } });
      if (updateReview.ok) {
        expect(updateReview.data.details).toContainEqual({
          label: "Name",
          value: "changed",
        });
      }
      const viewInput = {
        baseId: basePublicId,
        query: `from table {${tablePublicId}}\nselect {${fieldPublicId}}`,
        name: "Saved by Assistant",
        shared: false,
      };
      expect(await review("view.create", viewInput, context)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(await invoke("action", "view.create", viewInput, context)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      await sql`UPDATE auth.access SET permission = 'admin'::auth.permission_level WHERE id = ${accessIds[0]!}::uuid`;
      const before = await gridsService.view.listForTable({ tableId, userId: user.id });
      expect((await review("view.create", viewInput, userContext(user))).ok).toBeTrue();
      expect(await gridsService.view.listForTable({ tableId, userId: user.id })).toHaveLength(before.length);
      expect(await review("view.create", { ...viewInput, query: "not a query" }, userContext(user))).toMatchObject({
        ok: false,
        error: { code: "BAD_INPUT" },
      });
      const saved = await invoke("action", "view.create", viewInput, userContext(user));
      expect(saved.ok).toBeTrue();
      if (!saved.ok) throw new Error(saved.error.message);
      const storedView = await gridsService.view.getByShortId(saved.data.data.id);
      expect(storedView?.ownerUserId).toBe(user.id);
      expect(storedView?.source).toContain(tablePublicId);
      expect((await invoke("action", "view.create", viewInput, userContext(user))).ok).toBeFalse();
      const shared = await invoke("action", "view.create", { ...viewInput, name: "Shared by Assistant", shared: true }, userContext(user));
      expect(shared.ok).toBeTrue();
      if (shared.ok) expect((await gridsService.view.getByShortId(shared.data.data.id))?.ownerUserId).toBeNull();
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${baseId}::uuid`;
      for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
    }
  });

  postgresTest("confines resource-bound credentials and applies their permission cap", async () => {
    const boundBaseId = uuid();
    const otherBaseId = uuid();
    const tableId = uuid();
    const otherTableId = uuid();
    const fieldId = uuid();
    const boundBasePublicId = shortId("A");
    const otherBasePublicId = shortId("B");
    const tablePublicId = shortId("T");
    const otherTablePublicId = shortId("T");
    const fieldPublicId = shortId("F");
    const accessIds: string[] = [];
    const [serviceAccount] = await sql<{ id: string; createdAt: string }[]>`
      INSERT INTO auth.service_accounts (name, kind, app_id, resource_type, resource_id)
      VALUES ('Grids capability bound test', 'resource_bound', 'grids', 'base', ${boundBaseId})
      RETURNING id::text AS id, created_at::text AS "createdAt"
    `;
    if (!serviceAccount) throw new Error("Failed to create resource-bound capability fixture");
    try {
      await sql`
        INSERT INTO grids.bases (id, short_id, name)
        VALUES
          (${boundBaseId}::uuid, ${boundBasePublicId}, 'Bound capability Base'),
          (${otherBaseId}::uuid, ${otherBasePublicId}, 'Other capability Base')
      `;
      await sql`
        INSERT INTO grids.tables (id, short_id, base_id, name, position)
        VALUES (${tableId}::uuid, ${tablePublicId}, ${boundBaseId}::uuid, 'Bound items', 0),
          (${otherTableId}::uuid, ${otherTablePublicId}, ${otherBaseId}::uuid, 'Other items', 0)
      `;
      await sql`
        INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${fieldId}::uuid, ${fieldPublicId}, ${tableId}::uuid, 'Name', 'text', '{}'::jsonb, 0)
      `;
      for (const baseId of [boundBaseId, otherBaseId]) {
        const [access] = await sql<{ id: string }[]>`
          INSERT INTO auth.access (service_account_id, permission)
          VALUES (${serviceAccount.id}::uuid, 'admin'::auth.permission_level)
          RETURNING id::text AS id
        `;
        if (!access) throw new Error("Failed to create service-account access fixture");
        accessIds.push(access.id);
        await sql`INSERT INTO grids.base_access (base_id, access_id) VALUES (${baseId}::uuid, ${access.id}::uuid)`;
      }

      const context: CapabilityExecutionContext = {
        actor: {
          kind: "service_account",
          serviceAccount: {
            id: serviceAccount.id,
            name: "Grids capability bound test",
            kind: "resource_bound",
            status: "active",
            delegatedUserId: null,
            appId: "grids",
            resourceType: "base",
            resourceId: boundBaseId,
            createdBy: null,
            createdAt: serviceAccount.createdAt,
          },
          delegatedUser: null,
          scopes: ["grids:read"],
        },
        accessSubject: { type: "service_account", serviceAccountId: serviceAccount.id },
        user: null,
        locale: "en",
        signal: new AbortController().signal,
      };

      const listed = await invoke("query", "base.list", { limit: 25 }, context);
      expect(listed.ok && listed.data.data).toEqual([expect.objectContaining({ id: boundBasePublicId })]);
      const crossBase = await invoke("query", "base.read", { id: otherBasePublicId }, context);
      expect(crossBase).toMatchObject({ ok: false, error: { code: "FORBIDDEN", status: 403 } });
      const tables = await invoke("query", "gql.context", { baseId: boundBasePublicId, kind: "tables", limit: 25 }, context);
      expect(tables.ok && tables.data.data).toMatchObject({
        items: [{ id: tablePublicId, tableKind: "stored" }],
      });
      const fields = await invoke(
        "query",
        "gql.context",
        { baseId: boundBasePublicId, kind: "fields", tableId: tablePublicId, limit: 25, includeWriteContext: true },
        context,
      );
      expect(fields.ok && fields.data.data).toMatchObject({
        items: [{ id: fieldPublicId, writable: false }],
        recordWrite: { canCreateRecords: false, canUpdateRecords: false, updateAudit: null },
      });
      const write = await invoke("action", "record.create", { tableId: tablePublicId, values: {} }, context);
      expect(write).toMatchObject({ ok: false, error: { code: "FORBIDDEN", status: 403 } });
      const externalWrite = await invoke(
        "action",
        "record.upsert-external",
        {
          tableId: tablePublicId,
          externalRef: { provider: "crm", providerAccount: "main", resourceKind: "contact", externalId: "denied" },
          values: {},
        },
        { ...context, idempotencyKey: "denied-external-write" },
      );
      expect(externalWrite).toMatchObject({ ok: false, error: { code: "FORBIDDEN", status: 403 } });

      for (const [templateTableId, publicTableId, publicBaseId, allowed] of [
        [tableId, tablePublicId, boundBasePublicId, true],
        [otherTableId, otherTablePublicId, otherBasePublicId, false],
      ] as const) {
        const template = await gridsService.document.createTemplate(
          templateTableId,
          {
            name: "Credential-scoped receipt",
            source: `from table {${publicTableId}}`,
            renderer: {
              kind: "html",
              body: "<p>Receipt</p>",
              numberTemplate: "DOC-{{ series.value }}",
              filenameTemplate: "{{ document.number }}.pdf",
            },
          },
          null,
        );
        if (!template.ok) throw template.error;
        const templates = await invoke("query", "document.templates", { tableId: publicTableId }, context);
        const documents = await invoke("query", "document.list", { templateId: template.data.shortId }, context);
        const actions = await invoke("query", "workflow.record-actions", { baseId: publicBaseId }, context);
        if (allowed) {
          expect(templates.ok && templates.data.data).toMatchObject({ items: [{ id: template.data.shortId }], nextOffset: null });
          expect(documents.ok && documents.data.data).toEqual([]);
          expect(actions.ok && actions.data.data).toEqual({ items: [], nextOffset: null });
        } else {
          for (const result of [templates, documents, actions])
            expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN", status: 403 } });
        }
        // The scope gate must run before resolving a record or issuing anything.
        const input = { templateId: template.data.shortId, recordId: "REC001" };
        expect(await review("document.create", input, context)).toMatchObject({ ok: false, error: { code: "FORBIDDEN", status: 403 } });
        expect(await invoke("action", "document.create", input, { ...context, idempotencyKey: "denied-daily-issuance" })).toMatchObject({
          ok: false,
          error: { code: "FORBIDDEN", status: 403 },
        });
      }
    } finally {
      await sql`DELETE FROM grids.bases WHERE id IN (${boundBaseId}::uuid, ${otherBaseId}::uuid)`;
      for (const accessId of accessIds) await sql`DELETE FROM auth.access WHERE id = ${accessId}::uuid`;
      await sql`DELETE FROM auth.service_accounts WHERE id = ${serviceAccount.id}::uuid`;
    }
  });
});
