import { beforeAll, expect } from "bun:test";
import { sql } from "@k2b/cloud";
import type { CapabilityExecutionContext, User } from "@k2b/cloud/contracts";
import { testInfra } from "../../../scripts/fixtures/test-infra";
import { documentActor } from "./api/documents-api-shared";
import { gridsCapabilities } from "./capabilities";
import { postgresTest, testShortId } from "./integration-test-utils";
import { migrate } from "./migrate";
import { gridsService } from "./service";
import { persistDocumentData } from "./service/document-data";
import type { FinancialDocumentOutput } from "./service/document-financial-output";
import { canonicalDocumentJson } from "./service/document-json";
import { enable as enableHistory } from "./service/durable-history";
import { enable as enableFinalization } from "./service/record-finalization";
import { WorkflowValuesPayloadSchema } from "./workflows/query-contracts";

const uuid = () => Bun.randomUUIDv7();
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
  requestId: "req-test",
  origin: "app",
  signal: new AbortController().signal,
});

beforeAll(async () => {
  if (testInfra.database) await migrate();
});
const fixture = async () => {
  const [userRow] = await sql<Array<{ id: string }>>`SELECT id::text FROM auth.users ORDER BY id LIMIT 1`;
  if (!userRow) throw new Error("Requires auth user fixture");
  const user = testUser(userRow.id);
  const baseId = uuid(),
    tableId = uuid(),
    base = testShortId(),
    table = testShortId();
  await sql`INSERT INTO grids.bases(id,short_id,name) VALUES (${baseId}::uuid,${base},'Integrity capability test')`;
  await sql`INSERT INTO grids.tables(id,short_id,base_id,name) VALUES (${tableId}::uuid,${table},${baseId}::uuid,'Items')`;
  const [grant] = await sql<
    Array<{ id: string }>
  >`INSERT INTO auth.access(user_id,permission) VALUES (${user.id}::uuid,'write') RETURNING id::text`;
  if (!grant) throw new Error("Requires access fixture");
  await sql`INSERT INTO grids.base_access(base_id,access_id) VALUES (${baseId}::uuid,${grant.id}::uuid)`;
  const name = await gridsService.field.create({ tableId, name: "Name", type: "text", presentable: true }, user.id);
  if (!name.ok) throw name.error;
  const create = await gridsService.record.create(tableId, { [name.data.id]: "before" }, user.id, "direct");
  if (!create.ok) throw create.error;
  const context = { ...userContext(user), requestId: uuid(), idempotencyKey: uuid() };
  return { baseId, tableId, base, table, name: name.data, record: create.data, context, grantId: grant.id };
};
const cleanup = async (f: Awaited<ReturnType<typeof fixture>>) => {
  await sql`UPDATE grids.bases SET deleted_at=now() WHERE id=${f.baseId}::uuid`;
  await sql`DELETE FROM grids.base_access WHERE base_id=${f.baseId}::uuid AND access_id=${f.grantId}::uuid`;
  await sql`DELETE FROM auth.access WHERE id=${f.grantId}::uuid`;
};
const atomic = (input: unknown, context: CapabilityExecutionContext) => {
  const action = gridsCapabilities.actions["record.atomic"];
  return action.run(action.input.parse(input), context);
};
postgresTest("atomic capability rolls back earlier writes on a late stale version and rechecks assertions", async () => {
  const f = await fixture();
  try {
    const target = { tableId: f.table, recordId: f.record.shortId };
    const change = { kind: "update", ...target, ifVersion: f.record.version, values: { [f.name.shortId]: "after" } };
    const body = {
      baseId: f.base,
      locks: [target],
      checks: [
        { ...target, ifVersion: f.record.version, values: { [f.name.shortId]: "before" } },
        { query: `from table {${f.table}}\nwhere {${f.name.shortId}} = 'before'`, assert: "notEmpty" },
      ],
      changes: [change, { ...change, ifVersion: 999 }],
    };
    expect((await atomic(body, f.context)).ok).toBeFalse();
    expect((await gridsService.record.get(f.tableId, f.record.id))?.version).toBe(f.record.version);
    const success = await atomic({ ...body, changes: [change] }, f.context);
    expect(success.ok).toBeTrue();
    expect((await atomic({ ...body, changes: [change] }, f.context)).ok).toBeFalse();
    const [audit] = await sql<
      Array<{ diff: Record<string, unknown>; request_id: string }>
    >`SELECT diff,request_id FROM grids.audit_log WHERE table_id=${f.tableId}::uuid AND request_id=${f.context.requestId} ORDER BY created_at DESC LIMIT 1`;
    expect(audit?.request_id).toBe(f.context.requestId);
    expect(audit?.diff.capability).toMatchObject({ new: { origin: "app", actor: { kind: "user", id: f.context.user?.id } } });
    await sql`DELETE FROM grids.base_access WHERE base_id=${f.baseId}::uuid`;
    expect((await atomic({ ...body, changes: [change] }, f.context)).ok).toBeFalse();
  } finally {
    await cleanup(f);
  }
});
postgresTest("document capabilities capture, issue and read immutable bytes without a workflow run", async () => {
  const f = await fixture();
  try {
    const capture = gridsCapabilities.actions["document.capture"];
    const captured = await capture.run(
      capture.input.parse({ baseId: f.base, query: `from table {${f.table}}\nselect {${f.name.shortId}} as name` }),
      f.context,
    );
    expect(captured.ok).toBeTrue();
    if (!captured.ok) throw captured.error;
    const issue = gridsCapabilities.actions["document.issue"];
    const ids: string[] = [];
    for (const output of [
      { kind: "json" },
      { kind: "csv" },
      { kind: "xml", body: "<items>{% for row in rows %}<item>{{ row.name }}</item>{% endfor %}</items>" },
    ]) {
      const issued = await issue.run(issue.input.parse({ baseId: f.base, data: captured.data.data, output }), {
        ...f.context,
        requestId: uuid(),
        idempotencyKey: uuid(),
      });
      expect(issued.ok).toBeTrue();
      if (!issued.ok) throw issued.error;
      if (issued.data.data.state !== "issued") throw new Error("Nonfinancial output must issue immediately");
      const document = issued.data.data.document;
      ids.push(document.id);
      expect(document.dataSnapshot?.rowCount).toBe(1);
      const [stored] = await sql<
        Array<{ workflow_run_id: null; domain_data_id: string }>
      >`SELECT workflow_run_id,domain_data_id::text FROM grids.documents WHERE short_id=${document.id}`;
      expect(stored?.workflow_run_id).toBeNull();
      expect(stored?.domain_data_id).toBeString();
      const read = await gridsCapabilities.queries["document.read"].run({ id: document.id }, f.context);
      expect(read.ok).toBeTrue();
      const content = await gridsCapabilities.queries["document.content.read"].run({ id: document.id }, f.context);
      if (!content.ok || !content.data.stream) throw new Error("Missing artifact stream");
      const response = await gridsCapabilities.queries["document.content.read"].stream.read(content.data.stream, f.context);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    const zip = await issue.run(issue.input.parse({ baseId: f.base, data: captured.data.data, output: { kind: "zip", include: ids } }), {
      ...f.context,
      requestId: uuid(),
      idempotencyKey: uuid(),
    });
    expect(zip.ok && zip.data.data.state).toBe("issued");
    if (testInfra.gotenberg) {
      const pdf = await issue.run(
        issue.input.parse({
          baseId: f.base,
          data: captured.data.data,
          output: { kind: "pdf", body: "<h1>Items</h1>{% for row in rows %}<p>{{ row.name }}</p>{% endfor %}" },
        }),
        { ...f.context, requestId: uuid(), idempotencyKey: uuid() },
      );
      expect(pdf.ok && pdf.data.data.state).toBe("issued");
    }
    const [count] = await sql<
      Array<{ n: number }>
    >`SELECT count(*)::int AS n FROM grids.workflow_run_profile WHERE base_id=${f.baseId}::uuid`;
    expect(count?.n).toBe(0);
  } finally {
    await cleanup(f);
  }
});
postgresTest("finalization capability pins versions and correction drafts preserve the immutable original", async () => {
  const f = await fixture();
  try {
    const type = await gridsService.field.create(
      { tableId: f.tableId, name: "Kind", type: "select", config: { options: [{ id: "correction", label: "Correction" }] } },
      f.context.user!.id,
    );
    const relation = await gridsService.field.create(
      { tableId: f.tableId, name: "Original", type: "relation", config: { targetTableId: f.tableId, cardinality: "single" } },
      f.context.user!.id,
    );
    if (!type.ok || !relation.ok) throw new Error("Requires correction fields");
    expect((await enableHistory(f.tableId, f.context.user!.id)).ok).toBeTrue();
    const enabled = await enableFinalization(f.tableId, { mode: "direct" }, f.context.user!.id);
    if (!enabled.ok || !enabled.data.enabled) throw new Error("Requires finalization");
    const finalize = gridsCapabilities.actions["record.finalize"];
    const input = {
      tableId: f.table,
      recordId: f.record.shortId,
      ifVersion: f.record.version,
      expectedPolicyRevision: enabled.data.policyRevision,
    };
    const rejected = await finalize.run(
      finalize.input.parse({ ...input, expectedPolicyRevision: enabled.data.policyRevision + 1 }),
      f.context,
    );
    expect(rejected.ok).toBeFalse();
    const result = await finalize.run(finalize.input.parse(input), f.context);
    expect(result.ok).toBeTrue();
    const original = await gridsService.record.get(f.tableId, f.record.id);
    if (!original) throw new Error("Original missing");
    const draft = gridsCapabilities.actions["record.correction-draft"];
    const created = await draft.run(
      draft.input.parse({
        ...input,
        ifVersion: original.version,
        typeFieldId: type.data.shortId,
        typeValue: "correction",
        originalFieldId: relation.data.shortId,
        values: { [f.name.shortId]: "Correction draft" },
      }),
      f.context,
    );
    expect(created.ok).toBeTrue();
    expect((await gridsService.record.get(f.tableId, f.record.id))?.version).toBe(original.version);
  } finally {
    await cleanup(f);
  }
});

postgresTest("Four-eyes capability requires an independent eligible approver and resolves the request", async () => {
  const f = await fixture();
  const approverId = uuid(),
    groupId = uuid();
  let grantId: string | undefined;
  try {
    await sql`INSERT INTO auth.users (id,uid,provider,profile,display_name,given_name,sn) VALUES (${approverId}::uuid,${approverId},'local','user','Approver','Approve','User')`;
    await sql`INSERT INTO auth.groups (id,cn,provider,name) VALUES (${groupId}::uuid,${groupId},'local','Approvers')`;
    await sql`INSERT INTO auth.user_groups_v2 (user_id,group_id) VALUES (${approverId}::uuid,${groupId}::uuid)`;
    const [grant] = await sql<
      Array<{ id: string }>
    >`INSERT INTO auth.access(user_id,permission) VALUES (${approverId}::uuid,'write') RETURNING id::text`;
    if (!grant) throw new Error("Missing approver grant");
    grantId = grant.id;
    await sql`INSERT INTO grids.base_access(base_id,access_id) VALUES (${f.baseId}::uuid,${grantId}::uuid)`;
    expect((await enableHistory(f.tableId, f.context.user!.id)).ok).toBeTrue();
    const enabled = await enableFinalization(f.tableId, { mode: "fourEyes", approverGroupId: groupId }, f.context.user!.id);
    if (!enabled.ok || !enabled.data.enabled) throw new Error("Missing policy");
    const input = {
      tableId: f.table,
      recordId: f.record.shortId,
      ifVersion: f.record.version,
      expectedPolicyRevision: enabled.data.policyRevision,
    };
    const close = gridsCapabilities.actions["record.close"];
    expect((await close.run(close.input.parse(input), f.context)).ok).toBeTrue();
    const readiness = await gridsCapabilities.queries["record.finalization.read"].run(
      { tableId: f.table, recordId: f.record.shortId },
      f.context,
    );
    if (!readiness.ok || !readiness.data.data.request) throw new Error("Missing request");
    const approve = gridsCapabilities.actions["record.finalize"];
    const proposal = approve.input.parse({ ...input, approvalRequestId: readiness.data.data.request.id });
    expect((await approve.run(proposal, f.context)).ok).toBeFalse();
    const approved = await approve.run(proposal, { ...userContext(testUser(approverId)), requestId: uuid(), idempotencyKey: uuid() });
    expect(approved.ok).toBeTrue();
    const [resolved] = await sql<
      Array<{ status: string }>
    >`SELECT status FROM grids.record_finalization_requests WHERE table_id=${f.tableId}::uuid AND short_id=${proposal.approvalRequestId}`;
    expect(resolved?.status).toBe("approved");
  } finally {
    await cleanup(f);
    await sql`DELETE FROM grids.base_access WHERE base_id=${f.baseId}::uuid`;
    if (grantId) await sql`DELETE FROM auth.access WHERE id=${grantId}::uuid`;
    await sql`DELETE FROM grids.record_finalization_requests WHERE table_id=${f.tableId}::uuid`;
    await sql`DELETE FROM grids.table_finalization_activations WHERE table_id=${f.tableId}::uuid`;
    await sql`DELETE FROM auth.groups WHERE id=${groupId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id=${approverId}::uuid`;
  }
});

const output: FinancialDocumentOutput = {
  kind: "datev-csv",
  version: 1,
  header: {
    destinationKey: "accounting",
    consultantNumber: "12345",
    clientNumber: "1",
    fiscalYearStart: "2026-01-01",
    accountLength: 4,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    label: "September",
    finalize: false,
  },
  mapping: {
    businessId: "business",
    entryId: "entry",
    amount: "amount",
    direction: "side",
    account: "account",
    counterAccount: "other",
    documentDate: "date",
    documentNumber: "number",
  },
};

const sepaOutput: FinancialDocumentOutput = {
  kind: "sepa-xml",
  version: 1,
  header: { destinationKey: "main-bank", debtorName: "Example", debtorIban: "DE89370400440532013000", executionDate: "2026-09-14" },
  mapping: {
    businessId: "business",
    amount: "amount",
    endToEndId: "payment",
    creditorName: "payee",
    creditorIban: "iban",
    remittance: "purpose",
  },
};

postgresTest("DATEV and SEPA require exact confirmation and complete without workflow provenance", async () => {
  const f = await fixture();
  try {
    const row = {
      business: "invoice-1",
      entry: "main",
      amount: "12.30",
      side: "S",
      account: "00440",
      other: "70000",
      date: "2026-09-11",
      number: "INV-1",
      payment: "PAY-1",
      payee: "Example",
      iban: "DE89370400440532013000",
      purpose: "Invoice 1",
    };
    const capturedAt = "2026-11-06T00:00:00.000Z";
    const payload = WorkflowValuesPayloadSchema.parse({
      version: 2,
      columns: Object.keys(row).map((key) => ({ key, label: key, type: "text", sqlType: "text" })),
      rows: [row],
      rowOrigins: [{ recordId: null, tableId: null }],
      rowCount: 1,
      capturedAt,
      complete: true,
      selectionLimit: null,
      source: { kind: "values" },
      schemaHash: null,
      context: {},
      tableIds: [],
    });
    const capture = await persistDocumentData(
      {
        baseId: f.baseId,
        actor: documentActor(f.context.actor),
        requestId: f.context.requestId,
        operationKey: f.context.requestId,
        capture: { payload, sha256: canonicalDocumentJson(payload).sha256, rowCount: 1, capturedAt },
      },
      sql,
    );
    if (!capture.ok) throw capture.error;
    const data = { id: capture.data.shortId, sha256: capture.data.reference.sha256, rowCount: 1, capturedAt };
    const issue = gridsCapabilities.actions["document.issue"];
    const confirm = gridsCapabilities.actions["document.confirm"];
    for (const format of [output, sepaOutput]) {
      const context = { ...f.context, requestId: uuid(), idempotencyKey: uuid() };
      const body = {
        baseId: f.base,
        data,
        output: format,
        sourceVersions: [{ tableId: f.table, recordId: f.record.shortId, version: f.record.version }],
      };
      const reserved = await issue.run(issue.input.parse(body), context);
      expect(reserved.ok).toBeTrue();
      if (!reserved.ok) throw reserved.error;
      if (reserved.data.data.state !== "confirmationRequired") throw new Error("Financial export escaped confirmation");
      const input = { baseId: f.base, receiptId: reserved.data.data.receiptId, sha256: reserved.data.data.sha256 };
      const wrong = await confirm.run(confirm.input.parse({ ...input, sha256: "0".repeat(64) }), { ...context, idempotencyKey: uuid() });
      expect(wrong.ok).toBeFalse();
      const review = await confirm.review!(confirm.input.parse(input), context);
      expect(review.ok).toBeTrue();
      if (review.ok && "content" in review.data) expect(review.data.content?.body).toContain("12.30");
      const issued = await confirm.run(confirm.input.parse(input), { ...context, idempotencyKey: uuid() });
      expect(issued.ok).toBeTrue();
      if (!issued.ok) throw issued.error;
      const [document] = await sql<
        Array<{ workflow_run_id: null; domain_data_id: string }>
      >`SELECT workflow_run_id,domain_data_id::text FROM grids.documents WHERE short_id=${issued.data.data.id}`;
      expect(document?.workflow_run_id).toBeNull();
      expect(document?.domain_data_id).toBeString();
      const replay = await confirm.run(confirm.input.parse(input), { ...context, idempotencyKey: uuid() });
      expect(replay.ok && replay.data.data.id).toBe(issued.data.data.id);
    }
    // A preview cannot be confirmed after its explicitly pinned source changes.
    const pending = await issue.run(
      issue.input.parse({
        baseId: f.base,
        data,
        output,
        sourceVersions: [{ tableId: f.table, recordId: f.record.shortId, version: f.record.version }],
      }),
      { ...f.context, requestId: uuid(), idempotencyKey: uuid() },
    );
    if (!pending.ok || pending.data.data.state !== "confirmationRequired") throw new Error("Expected pending export");
    const changed = await gridsService.record.update(
      f.tableId,
      f.record.id,
      { [f.name.id]: "changed" },
      f.context.user!.id,
      "direct",
      f.record.version,
    );
    expect(changed.ok).toBeTrue();
    const refused = await confirm.run(
      confirm.input.parse({ baseId: f.base, receiptId: pending.data.data.receiptId, sha256: pending.data.data.sha256 }),
      { ...f.context, requestId: uuid(), idempotencyKey: uuid() },
    );
    expect(refused.ok).toBeFalse();
  } finally {
    await cleanup(f);
  }
});
