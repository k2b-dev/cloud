import { beforeAll, describe, expect } from "bun:test";
import { sql } from "bun";
import { postgresTest, testShortId as shortId, testUuid as uuid } from "../integration-test-utils";
import { migrate } from "../migrate";
import { submitForm } from "./form-submission";
import type { Form } from "./forms";
import { update as updateMutationPolicy } from "./mutation-policy";

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
  await sql`DELETE FROM grids.audit_log WHERE base_id = ${item.baseId}::uuid`;
  await sql`DELETE FROM grids.record_event_outbox WHERE base_id = ${item.baseId}::uuid`;
  await sql`DELETE FROM grids.bases WHERE id = ${item.baseId}::uuid`;
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("form submission integration", () => {
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
      if (!result.ok) expect(result.error.message).toBe("Field “Name” is required.");

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
