import { expect, test } from "bun:test";
import { PublicFormConfigSchema } from "./api/public-dto";
import { FormConfigSchema } from "./contracts";
import { customAppFormFieldHash, customAppFormSecurityHash } from "./custom-apps/form-capability";
import { ObjectListConfigSchema } from "./field-types/object-list";
import { normalizeFormConfig } from "./service/forms";

test("form widths survive stored normalization and public contracts, including inline and computed fields", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  for (const width of ["fullWidth", "compact"] as const) {
    const config = (fieldId: string) => ({
      fields: [{ kind: "user_input", fieldId, width, inlineCreate: { enabled: true, fields: [{ fieldId, width }] } }],
      computedFields: [{ fieldId, width }],
    });
    const stored = FormConfigSchema.parse(config(id));
    expect(normalizeFormConfig(stored)).toMatchObject(stored);
    expect(PublicFormConfigSchema.parse(config("Field1"))).toMatchObject(config("Field1"));
  }
  expect(FormConfigSchema.safeParse({ fields: [{ kind: "user_input", fieldId: id, width: "half" }] }).success).toBe(false);
  expect(PublicFormConfigSchema.safeParse({ fields: [], computedFields: [{ fieldId: "Field1", width: "half" }] }).success).toBe(false);
  expect(FormConfigSchema.parse({ fields: [{ kind: "user_input", fieldId: id }] }).fields[0]).not.toHaveProperty("width");
});

test("object-list widths affect neither calculations nor form authorization fingerprints", () => {
  const config = ObjectListConfigSchema.parse({
    fields: [
      { id: "Count1", name: "Count", type: "number" },
      { id: "Double", name: "Double", type: "number", formula: { expression: "Count1 * 2" } },
    ],
  });
  const field = {
    id: "Items1",
    tableId: "Table1",
    name: "Items",
    type: "object_list",
    config,
    deletedAt: null,
    required: false,
    defaultValue: null,
  };
  const compact = { ...field, config: { ...config, fields: config.fields.map((column) => ({ ...column, width: "compact" as const })) } };
  expect(ObjectListConfigSchema.parse(compact.config)).toEqual(compact.config);
  expect(ObjectListConfigSchema.safeParse({ fields: [{ ...config.fields[0], width: "half" }] }).success).toBe(false);
  expect(customAppFormFieldHash([field.id], [compact])).toBe(customAppFormFieldHash([field.id], [field]));
  const form = { fields: [{ kind: "user_input" as const, fieldId: field.id }] };
  const initial = customAppFormSecurityHash({ tableId: field.tableId, config: form, fields: [field] });
  expect(customAppFormSecurityHash({ tableId: field.tableId, config: form, fields: [compact] })).toBe(initial);
  expect(
    customAppFormSecurityHash({
      tableId: field.tableId,
      config: form,
      fields: [{ ...compact, config: { ...compact.config, maxItems: 20 } }],
    }),
  ).not.toBe(initial);
});

test("form sections survive public and stored contracts without changing authorization", () => {
  const section = { title: "Notes", description: "Only when needed", collapsible: true };
  const config = (fieldId: string) => ({ fields: [{ kind: "user_input" as const, fieldId, section }] });
  const stored = FormConfigSchema.parse(config("00000000-0000-4000-8000-000000000001"));
  expect(normalizeFormConfig(stored)).toMatchObject(stored);
  expect(PublicFormConfigSchema.parse(config("Field1"))).toEqual(config("Field1"));
  expect(PublicFormConfigSchema.safeParse({ fields: [{ ...config("Field1").fields[0], section: { title: " " } }] }).success).toBe(false);
  const field = { id: "Field1", tableId: "Table1", type: "text", config: {}, required: false, defaultValue: null, deletedAt: null };
  expect(customAppFormSecurityHash({ tableId: "Table1", config: config("Field1"), fields: [field] })).toBe(
    customAppFormSecurityHash({ tableId: "Table1", config: { fields: [{ kind: "user_input", fieldId: "Field1" }] }, fields: [field] }),
  );
});
