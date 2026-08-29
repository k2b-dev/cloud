import { describe, expect, test } from "bun:test";
import { fieldUniqueIndexName } from "./field-indexes";
import { recordUniqueConflict } from "./record-unique-conflicts";
import type { Field } from "./types";

const field = { id: "11111111-1111-4111-8111-111111111111", name: "External id", uniqueConstraint: true } as Field;

describe("recordUniqueConflict", () => {
  test("maps Bun SQL and postgres.js violations to the owning field", () => {
    const constraint = fieldUniqueIndexName(field.id);
    const bunConflict = recordUniqueConflict({ errno: "23505", constraint }, [field]);
    const postgresJsConflict = recordUniqueConflict({ code: "23505", constraint_name: constraint }, [field]);
    expect(bunConflict?.ok).toBe(false);
    expect(postgresJsConflict?.ok).toBe(false);
    if (bunConflict && !bunConflict.ok) expect(bunConflict.error.code).toBe("CONFLICT");
    if (postgresJsConflict && !postgresJsConflict.ok) expect(postgresJsConflict.error.message).toContain("field “External id”");
  });

  test("ignores unrelated constraints and non-unique fields", () => {
    expect(recordUniqueConflict({ errno: "23505", constraint: "other" }, [field])).toBeNull();
    expect(
      recordUniqueConflict({ errno: "23505", constraint: fieldUniqueIndexName(field.id) }, [{ ...field, uniqueConstraint: false }]),
    ).toBeNull();
  });
});
