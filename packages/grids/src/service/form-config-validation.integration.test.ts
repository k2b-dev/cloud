import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { migrate } from "../migrate";
import { validateFormConfig } from "./form-config-validation";

const postgresTest = process.env.GRIDS_DB_TEST === "1" ? test : test.skip;
const shortId = (prefix: string) => `${prefix}${Math.random().toString(36).slice(2, 7)}`.slice(0, 6);

const createFixture = async () => {
  const baseId = Bun.randomUUIDv7();
  const sourceTableId = Bun.randomUUIDv7();
  const targetTableId = Bun.randomUUIDv7();
  const nameFieldId = Bun.randomUUIDv7();
  const relationFieldId = Bun.randomUUIDv7();
  const targetNameFieldId = Bun.randomUUIDv7();
  const startFieldId = Bun.randomUUIDv7();
  const dueFieldId = Bun.randomUUIDv7();
  await sql`INSERT INTO grids.bases (id, short_id, name) VALUES (${baseId}::uuid, ${shortId("B")}, 'Form validation')`;
  await sql`
    INSERT INTO grids.tables (id, short_id, base_id, name, position)
    VALUES
      (${sourceTableId}::uuid, ${shortId("S")}, ${baseId}::uuid, 'Requests', 0),
      (${targetTableId}::uuid, ${shortId("T")}, ${baseId}::uuid, 'Contacts', 1)
  `;
  await sql`
    INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
    VALUES
      (${nameFieldId}::uuid, ${shortId("N")}, ${sourceTableId}::uuid, 'Name', 'text', '{}'::jsonb, 0),
      (
        ${relationFieldId}::uuid,
        ${shortId("R")},
        ${sourceTableId}::uuid,
        'Contact',
        'relation',
        ${{ targetTableId, cardinality: "multiple" }}::jsonb,
        1
      ),
      (${targetNameFieldId}::uuid, ${shortId("C")}, ${targetTableId}::uuid, 'Contact name', 'text', '{}'::jsonb, 0),
      (${startFieldId}::uuid, ${shortId("A")}, ${sourceTableId}::uuid, 'Start', 'date', '{}'::jsonb, 2),
      (${dueFieldId}::uuid, ${shortId("D")}, ${sourceTableId}::uuid, 'Due', 'date', '{}'::jsonb, 3)
  `;
  return { baseId, sourceTableId, nameFieldId, relationFieldId, targetNameFieldId, startFieldId, dueFieldId };
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("form config validation", () => {
  postgresTest("accepts compatible visible cross-field comparisons and rejects hidden fields", async () => {
    const fixture = await createFixture();
    try {
      const rule = {
        leftFieldId: fixture.startFieldId,
        operator: "lte",
        rightFieldId: fixture.dueFieldId,
        message: "Start must be on or before Due.",
      };
      const accepted = await validateFormConfig(fixture.sourceTableId, {
        fields: [
          { kind: "user_input", fieldId: fixture.startFieldId },
          { kind: "user_input", fieldId: fixture.dueFieldId },
        ],
        validations: [rule],
      });
      expect(accepted.ok).toBe(true);

      const hidden = await validateFormConfig(fixture.sourceTableId, {
        fields: [
          { kind: "form_value", fieldId: fixture.startFieldId, value: "2026-08-13" },
          { kind: "user_input", fieldId: fixture.dueFieldId },
        ],
        validations: [rule],
      });
      expect(hidden.ok).toBe(false);
      if (!hidden.ok) expect(hidden.error.message).toContain("visible user-input fields");
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });

  postgresTest("normalizes configured and inline-create defaults", async () => {
    const fixture = await createFixture();
    try {
      const result = await validateFormConfig(fixture.sourceTableId, {
        fields: [
          { kind: "form_value", fieldId: fixture.nameFieldId, value: "  Website  " },
          {
            kind: "user_input",
            fieldId: fixture.relationFieldId,
            inlineCreate: {
              enabled: true,
              fields: [{ fieldId: fixture.targetNameFieldId, defaultValue: "  Ada  " }],
            },
          },
        ],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.data.fields).toEqual([
        { kind: "form_value", fieldId: fixture.nameFieldId, value: "Website" },
        {
          kind: "user_input",
          fieldId: fixture.relationFieldId,
          inlineCreate: {
            enabled: true,
            fields: [{ fieldId: fixture.targetNameFieldId, defaultValue: "Ada" }],
          },
        },
      ]);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });

  postgresTest("rejects duplicate form fields with the field name", async () => {
    const fixture = await createFixture();
    try {
      const result = await validateFormConfig(fixture.sourceTableId, {
        fields: [
          { kind: "user_input", fieldId: fixture.nameFieldId },
          { kind: "user_input", fieldId: fixture.nameFieldId },
        ],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toBe("The Form references field “Name” more than once.");
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });
});
