import { beforeAll, describe, expect, test } from "bun:test";
import { sql } from "bun";
import { err, fail, ok } from "@k2b/stdlib";
import { createPublicFormRoutes } from "../api/form-public-routes";
import { createAuthenticatedFormRoutes } from "../api/form-authenticated-routes";
import * as forms from "./forms";
import { fromPublicFormConfig } from "../api/form-api-shared";
import { toPublicFields } from "../api/public-dto";
import { planFormComputedFields, previewFormComputedFields } from "../form-computed-fields";
import { migrate } from "../migrate";
import { listByTable } from "./fields";
import { customAppFormRelationScope } from "./custom-app-form-relations";
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
  return { baseId, sourceTableId, targetTableId, nameFieldId, relationFieldId, targetNameFieldId, startFieldId, dueFieldId };
};

beforeAll(async () => {
  if (process.env.GRIDS_DB_TEST === "1") await migrate();
});

describe("form config validation", () => {
  postgresTest("round-trips computed summaries with only visible dependency metadata", async () => {
    const fixture = await createFixture();
    try {
      const computedId = Bun.randomUUIDv7();
      await sql`INSERT INTO grids.fields (id, short_id, table_id, name, type, config, position)
        VALUES (${computedId}::uuid, ${shortId("F")}, ${fixture.sourceTableId}::uuid, 'Summary', 'formula',
          ${{ expression: "CONCAT(Name, '!')" }}::jsonb, 4)`;
      const config = { fields: [{ kind: "user_input", fieldId: fixture.nameFieldId }], computedFields: [{ fieldId: computedId }] };
      const accepted = await validateFormConfig(fixture.sourceTableId, config);
      expect(accepted.ok).toBe(true);
      const hidden = await validateFormConfig(
        fixture.sourceTableId,
        {
          fields: [{ kind: "user_input", fieldId: fixture.startFieldId }],
          computedFields: [{ fieldId: computedId }],
        },
        "de",
      );
      expect(hidden.ok).toBe(false);
      if (!hidden.ok) expect(hidden.error.message).toContain("keine sichtbare Formulareingabe");
      const fields = await listByTable(fixture.sourceTableId);
      const plan = planFormComputedFields([computedId], new Set([fixture.nameFieldId]), fields);
      if (!plan) throw new Error("Missing summary plan");
      const permitted = new Set(plan.fields.map((field) => field.id));
      const projected = await toPublicFields(fields.filter((field) => permitted.has(field.id)));
      expect(projected.length).toBe(2);
      const name = projected.find((field) => field.type === "text")!;
      const computed = projected.find((field) => field.type === "formula")!;
      expect(previewFormComputedFields([computed.id], new Set([name.id]), projected, { [name.id]: "Ada" })).toEqual({
        kind: "values",
        values: { [computed.id]: "Ada!" },
      });
      const restored = await fromPublicFormConfig(fixture.sourceTableId, {
        fields: [{ kind: "user_input", fieldId: name.id }],
        computedFields: [{ fieldId: computed.id }],
      });
      expect(restored?.computedFields).toEqual([{ fieldId: computedId }]);
      expect(
        (
          await validateFormConfig(fixture.sourceTableId, {
            ...config,
            fields: [{ kind: "form_value", fieldId: fixture.nameFieldId, value: "Hidden" }],
          })
        ).ok,
      ).toBe(false);
    } finally {
      await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
    }
  });
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

postgresTest("relation filter fields belong to the pinned target and schema drift invalidates selection scope", async () => {
  const fixture = await createFixture();
  try {
    const config = {
      fields: [
        {
          kind: "user_input" as const,
          fieldId: fixture.relationFieldId,
          relationFilter: { fieldId: fixture.targetNameFieldId, op: "startsWith", value: "Public" },
        },
      ],
    };
    expect((await validateFormConfig(fixture.sourceTableId, config)).ok).toBe(true);
    expect(
      (
        await validateFormConfig(fixture.sourceTableId, {
          fields: [{ ...config.fields[0], relationFilter: { fieldId: fixture.nameFieldId, op: "startsWith", value: "Public" } }],
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await validateFormConfig(fixture.sourceTableId, {
          fields: [{ ...config.fields[0], inlineCreate: { enabled: true, fields: [{ fieldId: fixture.targetNameFieldId }] } }],
        })
      ).ok,
    ).toBe(false);
    const fields = await listByTable(fixture.sourceTableId);
    const before = await customAppFormRelationScope({ tableId: fixture.sourceTableId, config }, fields, []);
    expect(before).not.toBeNull();
    await sql`UPDATE grids.fields SET config = ${{ maxLength: 20 }}::jsonb WHERE id = ${fixture.targetNameFieldId}::uuid`;
    const after = await customAppFormRelationScope({ tableId: fixture.sourceTableId, config }, fields, []);
    expect(after?.hash).not.toBe(before?.hash);
    await sql`UPDATE grids.fields SET type = 'number' WHERE id = ${fixture.targetNameFieldId}::uuid`;
    expect(await customAppFormRelationScope({ tableId: fixture.sourceTableId, config }, fields, [])).toBeNull();
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  }
});

postgresTest("standalone filtered pickers require active tokens or Base Write and expose only matching labels", async () => {
  const fixture = await createFixture();
  try {
    const saved = await forms.create(
      {
        tableId: fixture.sourceTableId,
        name: "Filtered request",
        isPublic: true,
        config: {
          fields: [
            {
              kind: "user_input",
              fieldId: fixture.relationFieldId,
              relationFilter: { fieldId: fixture.targetNameFieldId, op: "startsWith", value: "Public" },
            },
          ],
        },
      },
      null,
    );
    if (!saved.ok) throw saved.error;
    const publicId = shortId("P"),
      privateId = shortId("I");
    await sql`INSERT INTO grids.records (id, short_id, table_id, data) VALUES
      (${Bun.randomUUIDv7()}::uuid, ${publicId}, ${fixture.targetTableId}::uuid, ${{ [fixture.targetNameFieldId]: "Public camera" }}::jsonb),
      (${Bun.randomUUIDv7()}::uuid, ${privateId}, ${fixture.targetTableId}::uuid, ${{ [fixture.targetNameFieldId]: "Internal camera" }}::jsonb)`;
    const relation = (await listByTable(fixture.sourceTableId)).find((field) => field.id === fixture.relationFieldId)!;
    const endpoint = `/${saved.data.shortId}/relations/${relation.shortId}/lookup`;
    const publicEndpoint = `/public/${saved.data.publicToken}/relations/${relation.shortId}/lookup`;
    const publicRoutes = createPublicFormRoutes();
    const response = await publicRoutes.request(publicEndpoint);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ id: publicId, label: "Public camera" }] });
    expect((await publicRoutes.request(`/public/wrong/relations/${relation.shortId}/lookup`)).status).toBe(404);
    expect((await publicRoutes.request(publicEndpoint.replace(relation.shortId, "BAD001"))).status).toBe(404);
    let requiredLevel: unknown;
    const denied = createAuthenticatedFormRoutes({
      gate: async (_context, scope, level) => {
        requiredLevel = { scope, level };
        return fail(err.forbidden());
      },
    });
    expect((await denied.request(endpoint)).status).toBe(403);
    expect(requiredLevel).toEqual({ scope: { baseId: fixture.baseId }, level: "write" });
    const allowed = createAuthenticatedFormRoutes({ gate: async () => ok("write" as const) });
    const signedIn = await allowed.request(endpoint);
    expect(signedIn.status).toBe(200);
    expect(await signedIn.json()).toEqual({ items: [{ id: publicId, label: "Public camera" }] });
    await forms.update(saved.data.id, { isActive: false }, null);
    expect((await publicRoutes.request(publicEndpoint)).status).toBe(404);
    expect((await allowed.request(endpoint)).status).toBe(404);
  } finally {
    await sql`DELETE FROM grids.bases WHERE id = ${fixture.baseId}::uuid`;
  }
});
