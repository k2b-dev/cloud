import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId as shortId, testUuid as uuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import * as durableHistory from "./durable-history";
import { submitForm } from "./form-submission";
import type { Form } from "./forms";
import { update as updateMutationPolicy } from "./mutation-policy";
import * as finalization from "./record-finalization";

type Fixture = {
  baseId: string;
  sourceTableId: string;
  targetTableId: string;
  relationFieldId: string;
  sourceNameFieldId: string;
  targetNameFieldId: string;
  startFieldId: string;
  dueFieldId: string;
};

const fixture = (): Fixture => ({
  baseId: uuid(),
  sourceTableId: uuid(),
  targetTableId: uuid(),
  relationFieldId: uuid(),
  sourceNameFieldId: uuid(),
  targetNameFieldId: uuid(),
  startFieldId: uuid(),
  dueFieldId: uuid(),
});

const insertFixture = async (item: Fixture) => {
  await sql`
    INSERT INTO grids.bases (id, short_id, name)
    VALUES (${item.baseId}::uuid, ${shortId("B")}, 'Form submission integration')
  `;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES
      (${item.sourceTableId}::uuid, ${shortId("S")}, ${item.baseId}::uuid, 'Orders', 0),
      (${item.targetTableId}::uuid, ${shortId("T")}, ${item.baseId}::uuid, 'Contacts', 1)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, required, position)
    VALUES
      (${item.sourceNameFieldId}::uuid, ${shortId("N")}, ${item.sourceTableId}::uuid, 'Reference', 'text', '{}'::jsonb, TRUE, 0),
      (
        ${item.relationFieldId}::uuid,
        ${shortId("R")},
        ${item.sourceTableId}::uuid,
        'Contact',
        'relation',
        ${{ targetTableId: item.targetTableId, cardinality: "multiple" }}::jsonb,
        FALSE,
        1
      ),
      (${item.targetNameFieldId}::uuid, ${shortId("C")}, ${item.targetTableId}::uuid, 'Name', 'text', '{}'::jsonb, TRUE, 0),
      (${item.startFieldId}::uuid, ${shortId("A")}, ${item.sourceTableId}::uuid, 'Start', 'date', '{}'::jsonb, FALSE, 2),
      (${item.dueFieldId}::uuid, ${shortId("D")}, ${item.sourceTableId}::uuid, 'Due', 'date', '{}'::jsonb, FALSE, 3)
  `;
};

const formFor = (item: Fixture): Form => ({
  id: uuid(),
  shortId: shortId("F"),
  tableId: item.sourceTableId,
  name: "Order",
  config: {
    fields: [
      { kind: "user_input", fieldId: item.sourceNameFieldId, required: true },
      {
        kind: "user_input",
        fieldId: item.relationFieldId,
        inlineCreate: {
          enabled: true,
          fields: [{ fieldId: item.targetNameFieldId, required: true }],
        },
      },
    ],
  },
  publicToken: null,
  isActive: true,
  ownerUserId: null,
  position: 0,
  isDefault: false,
  deletedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const cleanup = async (item: Fixture) => {
  await sql`UPDATE grids.records SET finalized_at = NULL, finalized_by = NULL, final_revision_id = NULL WHERE table_id = ${item.sourceTableId}::uuid`;
  await sql`DELETE FROM grids.record_revisions WHERE table_id = ${item.sourceTableId}::uuid`;
  await sql`DELETE FROM grids.table_finalization_activations WHERE table_id = ${item.sourceTableId}::uuid`;
  await sql`DELETE FROM grids.durable_history_activations WHERE table_id = ${item.sourceTableId}::uuid`;
  await sql`DELETE FROM grids.table_schema_revisions WHERE table_id = ${item.sourceTableId}::uuid`;
  await sql`DELETE FROM grids.audit_log WHERE base_id = ${item.baseId}::uuid`;
  await sql`DELETE FROM grids.record_event_outbox WHERE base_id = ${item.baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("form submission integration", () => {
  postgresTest("keeps empty inline object lists distinct from omitted defaults", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const listId = uuid();
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, default_value, position)
        VALUES (${listId}::uuid, ${shortId("L")}, ${item.targetTableId}::uuid, 'Items', 'object_list',
          ${{ fields: [{ id: "Amount", name: "Amount", type: "number" }] }}::jsonb,
          '[{"Amount":"7"}]'::jsonb, 1)`;
      const form = formFor(item);
      form.config.fields = [
        { kind: "user_input", fieldId: item.sourceNameFieldId },
        {
          kind: "user_input",
          fieldId: item.relationFieldId,
          inlineCreate: { enabled: true, fields: [{ fieldId: item.targetNameFieldId, required: true }, { fieldId: listId }] },
        },
      ];
      const result = await submitForm({
        form,
        actorId: null,
        dateConfig: {},
        submission: {
          idempotencyKey: "empty-versus-absent-list",
          data: { [item.sourceNameFieldId]: "ORDER", [item.relationFieldId]: ["tmp_empty", "tmp_default"] },
          inlineCreates: {
            [item.relationFieldId]: [
              { tempId: "tmp_empty", data: { [item.targetNameFieldId]: "Empty", [listId]: [] } },
              { tempId: "tmp_default", data: { [item.targetNameFieldId]: "Default" } },
            ],
          },
        },
      });
      if (!result.ok) throw result.error;
      const rows = await sql<
        { data: Record<string, unknown> }[]
      >`SELECT data FROM grids.records WHERE table_id = ${item.targetTableId}::uuid`;
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.data[item.targetNameFieldId] === "Empty")?.data[listId]).toEqual([]);
      expect(rows.find((row) => row.data[item.targetNameFieldId] === "Default")?.data[listId]).toEqual([{ Amount: "7" }]);
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("edits a parent and its inline rows atomically and replays the same save", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const form = formFor(item);
      const created = await submitForm({
        form,
        actorId: null,
        dateConfig: {},
        submission: {
          data: { [item.sourceNameFieldId]: "Draft" },
          inlineCreates: { [item.relationFieldId]: [{ tempId: "tmp_first", data: { [item.targetNameFieldId]: "First" } }] },
        },
      });
      if (!created.ok) throw new Error(created.error.message);
      const [child] = await sql<
        { id: string; version: number }[]
      >`SELECT id, version FROM grids.records WHERE table_id = ${item.targetTableId}::uuid`;
      const [parent] = await sql<{ version: number }[]>`SELECT version FROM grids.records WHERE id = ${created.data.recordId}::uuid`;
      if (!child || !parent) throw new Error("Missing fixture records");
      const input = {
        form,
        actorId: null,
        dateConfig: {},
        record: { id: created.data.recordId, version: parent.version },
        submission: {
          idempotencyKey: "edit-draft",
          data: { [item.sourceNameFieldId]: "Updated", [item.relationFieldId]: [child.id] },
          inlineCreates: { [item.relationFieldId]: [{ tempId: "tmp_second", data: { [item.targetNameFieldId]: "Second" } }] },
          inlineUpdates: {
            [item.relationFieldId]: [{ recordId: child.id, version: child.version, data: { [item.targetNameFieldId]: "First updated" } }],
          },
        },
      };
      const saved = await submitForm(input);
      expect(saved).toEqual(created);
      expect(await submitForm(input)).toEqual(saved);
      const rows = await sql<
        { id: string; data: Record<string, unknown>; version: number }[]
      >`SELECT id, data, version FROM grids.records WHERE table_id IN (${item.sourceTableId}::uuid, ${item.targetTableId}::uuid)`;
      expect(rows).toHaveLength(3);
      expect(rows.find((row) => row.id === child.id)?.data[item.targetNameFieldId]).toBe("First updated");
      expect(rows.find((row) => row.id === created.data.recordId)?.data[item.sourceNameFieldId]).toBe("Updated");
      const [links] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM grids.record_links WHERE from_record_id = ${created.data.recordId}::uuid`;
      expect(links?.count).toBe(2);

      // The new row is written before the stale child is encountered: neither may survive.
      const currentParent = rows.find((row) => row.id === created.data.recordId)!;
      const rejected = await submitForm({
        ...input,
        record: { id: created.data.recordId, version: currentParent.version },
        submission: { ...input.submission, idempotencyKey: "stale-child" },
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("CONFLICT");
      const [counts] = await sql<{ records: number; receipts: number; events: number }[]>`
        SELECT (SELECT count(*)::int FROM grids.records WHERE table_id IN (${item.sourceTableId}::uuid, ${item.targetTableId}::uuid)) AS records,
        (SELECT count(*)::int FROM grids.form_submissions WHERE table_id = ${item.sourceTableId}::uuid) AS receipts,
        (SELECT count(*)::int FROM grids.record_event_outbox WHERE base_id = ${item.baseId}::uuid) AS events
      `;
      expect(counts).toEqual({ records: 3, receipts: 1, events: 5 });
      const sharedBy = uuid();
      await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES (${sharedBy}::uuid, ${shortId("R")}, ${item.sourceTableId}::uuid, '{}'::jsonb)`;
      await sql`INSERT INTO grids.record_links (from_record_id, from_field_id, to_record_id) VALUES (${sharedBy}::uuid, ${item.relationFieldId}::uuid, ${child.id}::uuid)`;
      const sharedEdit = await submitForm({
        ...input,
        record: { id: created.data.recordId, version: currentParent.version },
        submission: {
          ...input.submission,
          idempotencyKey: "shared-child",
          inlineCreates: {},
          inlineUpdates: {
            [item.relationFieldId]: [{ recordId: child.id, version: child.version + 1, data: { [item.targetNameFieldId]: "Shared edit" } }],
          },
        },
      });
      expect(sharedEdit.ok).toBe(false);
      if (!sharedEdit.ok) expect(sharedEdit.error.code).toBe("BAD_INPUT");
      await sql`DELETE FROM grids.records WHERE id = ${sharedBy}::uuid`;
      expect((await durableHistory.enable(item.sourceTableId, null)).ok).toBe(true);
      expect((await finalization.enable(item.sourceTableId, { mode: "direct" }, null)).ok).toBe(true);
      const finalizedRecord = await finalization.finalize({
        tableId: item.sourceTableId,
        recordId: created.data.recordId,
        actorId: null,
        origin: "form",
      });
      if (!finalizedRecord.ok) throw finalizedRecord.error;
      const finalized = await submitForm({
        ...input,
        record: { id: created.data.recordId, version: finalizedRecord.data.version },
        submission: {
          ...input.submission,
          idempotencyKey: "finalized-parent",
          inlineUpdates: {
            [item.relationFieldId]: [
              { recordId: child.id, version: child.version + 1, data: { [item.targetNameFieldId]: "Must roll back" } },
            ],
          },
        },
      });
      expect(finalized.ok).toBe(false);
      if (!finalized.ok) expect(finalized.error.code).toBe("CONFLICT");
      const [unchanged] = await sql<{ data: Record<string, unknown> }[]>`SELECT data FROM grids.records WHERE id = ${child.id}::uuid`;
      expect(unchanged?.data[item.targetNameFieldId]).toBe("First updated");
      const [remaining] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${item.targetTableId}::uuid`;
      expect(remaining?.count).toBe(2);
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("create-only submissions cannot mutate existing inline rows", async () => {
    const item = fixture();
    const result = await submitForm({
      form: formFor(item),
      actorId: null,
      dateConfig: {},
      submission: { data: {}, inlineCreates: {}, inlineUpdates: { [item.relationFieldId]: [{ recordId: uuid(), version: 1, data: {} }] } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("BAD_INPUT");
  });

  postgresTest("replays concurrent submissions without duplicating the parent, inline records or events", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const form = formFor(item);
      const input = {
        form,
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        submission: {
          idempotencyKey: "same-attempt",
          data: { [item.sourceNameFieldId]: "ORDER", [item.relationFieldId]: ["tmp_one", "tmp_two"] },
          inlineCreates: {
            [item.relationFieldId]: [
              { tempId: "tmp_one", data: { [item.targetNameFieldId]: "One" } },
              { tempId: "tmp_two", data: { [item.targetNameFieldId]: "Two" } },
            ],
          },
        },
      };
      const results = await Promise.all([submitForm(input), submitForm(input), submitForm(input)]);
      expect(results.every((result) => result.ok)).toBe(true);
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      const [counts] = await sql<{ records: number; events: number; receipts: number }[]>`
        SELECT (SELECT count(*)::int FROM grids.records WHERE table_id IN (${item.sourceTableId}::uuid, ${item.targetTableId}::uuid)) AS records,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE base_id = ${item.baseId}::uuid) AS events,
          (SELECT count(*)::int FROM grids.form_submissions WHERE table_id = ${item.sourceTableId}::uuid) AS receipts
      `;
      expect(counts).toEqual({ records: 3, events: 3, receipts: 1 });
      const changed = await submitForm({
        ...input,
        submission: { ...input.submission, data: { ...input.submission.data, [item.sourceNameFieldId]: "CHANGED" } },
      });
      expect(changed.ok).toBe(false);
      if (!changed.ok) expect(changed.error.code).toBe("CONFLICT");
      const first = results[0];
      if (!first?.ok) throw new Error("Missing first result");
      await sql`UPDATE grids.records SET deleted_at = now() WHERE id = ${first.data.recordId}::uuid`;
      const removed = await submitForm(input);
      expect(removed.ok).toBe(false);
      if (!removed.ok) expect(removed.error.code).toBe("CONFLICT");
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("a rejected submission does not consume its retry key", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const form = formFor(item);
      const submission = {
        idempotencyKey: "failed-first",
        data: { [item.sourceNameFieldId]: "ORDER" },
        inlineCreates: { [item.relationFieldId]: [{ tempId: "tmp_line", data: {} }] },
      };
      expect((await submitForm({ form, actorId: null, dateConfig: {}, submission })).ok).toBe(false);
      const result = await submitForm({
        form,
        actorId: null,
        dateConfig: {},
        submission: {
          ...submission,
          inlineCreates: { [item.relationFieldId]: [{ tempId: "tmp_line", data: { [item.targetNameFieldId]: "Fixed" } }] },
        },
      });
      expect(result.ok).toBe(true);
      const [count] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM grids.form_submissions WHERE table_id = ${item.sourceTableId}::uuid`;
      expect(count?.count).toBe(1);
    } finally {
      await cleanup(item);
    }
  });
  postgresTest("enforces cross-field validation before creating a record", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const form = formFor(item);
      form.config.fields.push({ kind: "user_input", fieldId: item.startFieldId }, { kind: "user_input", fieldId: item.dueFieldId });
      form.config.validations = [
        {
          leftFieldId: item.startFieldId,
          operator: "lte",
          rightFieldId: item.dueFieldId,
          message: "Start must be on or before Due.",
        },
      ];
      const result = await submitForm({
        form,
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        submission: {
          data: {
            [item.sourceNameFieldId]: "ORDER-INVALID",
            [item.startFieldId]: "2026-08-14",
            [item.dueFieldId]: "2026-08-13",
          },
          inlineCreates: {},
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("Start must be on or before Due.");
      const [{ count } = { count: 0 }] = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM grids.records WHERE table_id = ${item.sourceTableId}::uuid
      `;
      expect(count).toBe(0);
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("applies trusted request-scoped fixed values and rejects browser overrides", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const contact = await submitForm({
        form: {
          ...formFor(item),
          tableId: item.targetTableId,
          config: { fields: [{ kind: "user_input", fieldId: item.targetNameFieldId, required: true }] },
        },
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        submission: { data: { [item.targetNameFieldId]: "Ada" }, inlineCreates: {} },
      });
      expect(contact.ok).toBe(true);
      if (!contact.ok) throw new Error(contact.error.message);

      const tampered = await submitForm({
        form: formFor(item),
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        fixedValues: { [item.relationFieldId]: contact.data.recordId },
        submission: {
          data: { [item.sourceNameFieldId]: "ORDER-TAMPER", [item.relationFieldId]: uuid() },
          inlineCreates: {},
        },
      });
      expect(tampered.ok).toBe(false);
      if (!tampered.ok) expect(tampered.error.message).toContain("is fixed by this Form context");

      const inlineTampered = await submitForm({
        form: formFor(item),
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        fixedValues: { [item.relationFieldId]: contact.data.recordId },
        submission: {
          data: { [item.sourceNameFieldId]: "ORDER-INLINE-TAMPER" },
          inlineCreates: {
            [item.relationFieldId]: [{ tempId: "tmp_contact", data: { [item.targetNameFieldId]: "Injected" } }],
          },
        },
      });
      expect(inlineTampered.ok).toBe(false);
      if (!inlineTampered.ok) expect(inlineTampered.error.message).toContain("is fixed by this Form context");

      const [{ recordsBeforeCreate } = { recordsBeforeCreate: 0 }] = await sql<Array<{ recordsBeforeCreate: number }>>`
        SELECT count(*)::int AS "recordsBeforeCreate"
        FROM grids.records r
        JOIN grids.tables t ON t.id = r.table_id
        WHERE t.base_id = ${item.baseId}::uuid AND r.deleted_at IS NULL
      `;
      expect(recordsBeforeCreate).toBe(1);

      const created = await submitForm({
        form: formFor(item),
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        fixedValues: { [item.relationFieldId]: contact.data.recordId },
        submission: { data: { [item.sourceNameFieldId]: "ORDER-1" }, inlineCreates: {} },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error(created.error.message);
      const [link] = await sql<Array<{ to_record_id: string }>>`
        SELECT to_record_id::text
        FROM grids.record_links
        WHERE from_record_id = ${created.data.recordId}::uuid AND from_field_id = ${item.relationFieldId}::uuid
      `;
      expect(link?.to_record_id).toBe(contact.data.recordId);
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("creates inline records, relation links, and durable events atomically", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const result = await submitForm({
        form: formFor(item),
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        submission: {
          data: { [item.sourceNameFieldId]: "ORDER-1", [item.relationFieldId]: ["tmp_contact"] },
          inlineCreates: {
            [item.relationFieldId]: [{ tempId: "tmp_contact", data: { [item.targetNameFieldId]: "Ada" } }],
          },
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);

      const [link] = await sql<Array<{ from_record_id: string; to_record_id: string }>>`
        SELECT from_record_id::text, to_record_id::text
        FROM grids.record_links
        WHERE from_field_id = ${item.relationFieldId}::uuid
      `;
      expect(link?.from_record_id).toBe(result.data.recordId);
      expect(link?.to_record_id).toBeString();

      const [{ records, events } = { records: 0, events: 0 }] = await sql<Array<{ records: number; events: number }>>`
        SELECT
          (SELECT count(*)::int FROM grids.records r JOIN grids.tables t ON t.id = r.table_id WHERE t.base_id = ${item.baseId}::uuid) AS records,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE base_id = ${item.baseId}::uuid) AS events
      `;
      expect({ records, events }).toEqual({ records: 2, events: 2 });
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("rolls back the whole submission when an inline target blocks Forms", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const policy = await updateMutationPolicy(item.targetTableId, { mode: "selected", sources: ["direct", "workflow"] }, null);
      if (!policy.ok) throw policy.error;

      const result = await submitForm({
        form: formFor(item),
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        submission: {
          data: { [item.sourceNameFieldId]: "ORDER-BLOCKED", [item.relationFieldId]: ["tmp_contact"] },
          inlineCreates: {
            [item.relationFieldId]: [{ tempId: "tmp_contact", data: { [item.targetNameFieldId]: "Ada" } }],
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.status).toBe(403);

      const [{ records, links, events } = { records: 0, links: 0, events: 0 }] = await sql<
        Array<{ records: number; links: number; events: number }>
      >`
        SELECT
          (SELECT count(*)::int FROM grids.records record JOIN grids.tables table_ref ON table_ref.id = record.table_id WHERE table_ref.base_id = ${item.baseId}::uuid) AS records,
          (SELECT count(*)::int FROM grids.record_links link JOIN grids.records record ON record.id = link.from_record_id JOIN grids.tables table_ref ON table_ref.id = record.table_id WHERE table_ref.base_id = ${item.baseId}::uuid) AS links,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE base_id = ${item.baseId}::uuid) AS events
      `;
      expect({ records, links, events }).toEqual({ records: 0, links: 0, events: 0 });
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("rolls back earlier inline records when a later draft is invalid", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const result = await submitForm({
        form: formFor(item),
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        submission: {
          data: { [item.sourceNameFieldId]: "ORDER-2", [item.relationFieldId]: ["tmp_valid", "tmp_invalid"] },
          inlineCreates: {
            [item.relationFieldId]: [
              { tempId: "tmp_valid", data: { [item.targetNameFieldId]: "Ada" } },
              { tempId: "tmp_invalid", data: {} },
            ],
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("Contact, row 2: Field “Name” is required.");

      const [{ records, links, events } = { records: 0, links: 0, events: 0 }] = await sql<
        Array<{ records: number; links: number; events: number }>
      >`
        SELECT
          (SELECT count(*)::int FROM grids.records r JOIN grids.tables t ON t.id = r.table_id WHERE t.base_id = ${item.baseId}::uuid) AS records,
          (SELECT count(*)::int FROM grids.record_links rl JOIN grids.records r ON r.id = rl.from_record_id JOIN grids.tables t ON t.id = r.table_id WHERE t.base_id = ${item.baseId}::uuid) AS links,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE base_id = ${item.baseId}::uuid) AS events
      `;
      expect({ records, links, events }).toEqual({ records: 0, links: 0, events: 0 });
    } finally {
      await cleanup(item);
    }
  });

  postgresTest("rejects duplicate inline draft ids before creating records or events", async () => {
    const item = fixture();
    try {
      await insertFixture(item);
      const result = await submitForm({
        form: formFor(item),
        actorId: null,
        dateConfig: { timeZone: "UTC" },
        submission: {
          data: { [item.sourceNameFieldId]: "ORDER-3", [item.relationFieldId]: ["tmp_contact"] },
          inlineCreates: {
            [item.relationFieldId]: [
              { tempId: "tmp_contact", data: { [item.targetNameFieldId]: "Ada" } },
              { tempId: "tmp_contact", data: { [item.targetNameFieldId]: "Grace" } },
            ],
          },
        },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("Field “Contact” contains a duplicate inline draft ID.");

      const [{ records, events } = { records: 0, events: 0 }] = await sql<Array<{ records: number; events: number }>>`
        SELECT
          (SELECT count(*)::int FROM grids.records r JOIN grids.tables t ON t.id = r.table_id WHERE t.base_id = ${item.baseId}::uuid) AS records,
          (SELECT count(*)::int FROM grids.record_event_outbox WHERE base_id = ${item.baseId}::uuid) AS events
      `;
      expect({ records, events }).toEqual({ records: 0, events: 0 });
    } finally {
      await cleanup(item);
    }
  });
});
