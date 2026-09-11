import { describe, expect, test } from "bun:test";
import { ObjectListConfigSchema, validateObjectList } from "../field-types/object-list";
import { fieldTypeReference, fieldTypeReferences, recordShapeForFields } from "./schema-support";

const table = { id: "Table1", name: "Invoices", kind: "stored" as const };
const config = {
  fields: [
    { id: "Label1", name: "Label", type: "text", required: true },
    { id: "Amount", name: "Amount", type: "number", config: { decimalPlaces: 2 } },
    { id: "Rate01", name: "Rate", type: "percent", config: { range: "fraction" } },
    { id: "Total1", name: "Total", type: "number", formula: { expression: "Amount * 2" } },
  ],
  minItems: 2,
};
const field = { id: "Items1", name: "Items", type: "object_list", required: true, config, defaultValue: null, deletedAt: null };

describe("CLI typed list discovery", () => {
  test("describes every registered type, with a usable object-list config and value", () => {
    expect(fieldTypeReferences().filter((type) => type.recordValue === "(unknown)")).toEqual([]);
    const reference = fieldTypeReference("object_list");
    const parsed = ObjectListConfigSchema.parse(JSON.parse(reference.config));
    expect(validateObjectList(JSON.parse(reference.recordValue), parsed, false).ok).toBe(true);
    expect(reference.recordWritable).toBe(true);
    expect(reference.notes).toContain("Omit columns with formula");
  });

  test("builds rows from actual writable columns and preserves exact scalar shapes", () => {
    const shape = recordShapeForFields(table, [field]);
    expect(shape.example.Items1).toEqual([
      { Label1: "Text value", Amount: "42", Rate01: 0.5 },
      { Label1: "Text value", Amount: "42", Rate01: 0.5 },
    ]);
    expect(validateObjectList(shape.example.Items1, ObjectListConfigSchema.parse(config), true).ok).toBe(true);
    expect(shape.writableFields[0]?.config).toEqual(config);
    expect(shape.readOnlyFields).toEqual([]);
  });

  test("removes calculated cells from trusted defaults without changing the default", () => {
    const defaultValue = [{ Label1: "Consulting", Amount: "0.15", Rate01: 0.5, Total1: "0.30" }];
    const shape = recordShapeForFields(table, [{ ...field, defaultValue }]);
    expect(shape.example.Items1).toEqual([{ Label1: "Consulting", Amount: "0.15", Rate01: 0.5 }]);
    expect(defaultValue[0]?.Total1).toBe("0.30");
    expect(recordShapeForFields(table, [{ ...field, defaultValue: [] }]).example.Items1).toEqual([]);
  });

  test("does not advertise writable records for a Combined table", () => {
    const shape = recordShapeForFields({ ...table, kind: "federated" }, [field]);
    expect(shape.example).toEqual({});
    expect(shape.writableFields).toEqual([]);
    expect(shape.readOnlyFields).toEqual([{ id: "Items1", name: "Items", type: "object_list" }]);
  });
});
