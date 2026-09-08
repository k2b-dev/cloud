import { describe, expect, test } from "bun:test";
import { normalizedSql } from "../sql-test-utils";
import { compileSort, decodeCursor } from "./sort-compiler";
import type { Field } from "./types";

const mkField = (id: string, type: string): Field => ({
  id,
  shortId: id,
  tableId: "t1",
  name: id,
  description: null,
  type,
  config: {},
  presentable: false,
  hideInTable: false,
  position: 0,
  required: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
  deletedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const fields: Field[] = [mkField("fld_a", "text"), mkField("fld_b", "number"), mkField("fld_c", "date")];
const recordId = "00000000-0000-4000-8000-000000000001";

describe("compileSort — validation", () => {
  test("rejects unknown field", () => {
    const r = compileSort([{ fieldId: "fld_missing", direction: "asc" }], fields, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/unknown sort field/);
  });

  test("rejects deleted field", () => {
    const dead = { ...mkField("fld_x", "text"), deletedAt: "2026-01-01T00:00:00Z" };
    const r = compileSort([{ fieldId: "fld_x", direction: "asc" }], [...fields, dead], null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/deleted/);
  });

  test("accepts mixed asc/desc directions (Slice 7 unblock)", () => {
    // v3: mixed directions are supported. Per-column orderGt handles
    // per-direction comparisons; the id tiebreaker uses the FIRST
    // column's direction for consistency. A pre-existing rejection
    // here was conservative; the underlying logic always worked.
    const r = compileSort(
      [
        { fieldId: "fld_a", direction: "asc" },
        { fieldId: "fld_b", direction: "desc" },
      ],
      fields,
      { values: ["x", 5], id: recordId },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.fieldIds).toEqual(["fld_a", "fld_b"]);
  });

  test("accepts mixed directions on first page (no cursor) too", () => {
    const r = compileSort(
      [
        { fieldId: "fld_a", direction: "asc" },
        { fieldId: "fld_b", direction: "desc" },
      ],
      fields,
      null,
    );
    expect(r.ok).toBe(true);
  });

  test("accepts record metadata sort", () => {
    const r = compileSort(
      [
        { source: "record", key: "createdAt", direction: "desc" },
        { fieldId: "fld_a", direction: "asc" },
      ],
      fields,
      null,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.fieldIds).toEqual(["record:createdAt", "fld_a"]);
  });

  test("projects timestamp cursor values with PostgreSQL microsecond precision", () => {
    const compiled = compileSort([{ source: "record", key: "createdAt", direction: "asc" }], fields, null);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(normalizedSql(compiled.result.cursorSelect)).toContain(
      "to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')",
    );
  });

  test("succeeds with empty sort spec (no cursor)", () => {
    const r = compileSort([], fields, null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.fieldIds).toEqual([]);
      expect(r.result.cursorWhere).toBeNull();
    }
  });

  test("succeeds with single asc sort + cursor", () => {
    const r = compileSort([{ fieldId: "fld_b", direction: "asc" }], fields, { values: [42], id: recordId });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.fieldIds).toEqual(["fld_b"]);
      expect(r.result.cursorWhere).not.toBeNull();
      expect(typeof r.result.encodeCursorFromRow).toBe("function");
    }
  });

  test("succeeds with multi-column desc sort + cursor", () => {
    const r = compileSort(
      [
        { fieldId: "fld_c", direction: "desc" },
        { fieldId: "fld_b", direction: "desc" },
      ],
      fields,
      { values: ["2026-05-01", 100], id: recordId },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.result.fieldIds).toEqual(["fld_c", "fld_b"]);
      // Cursor encoding reads shared SQL keyset aliases instead of
      // exposing per-field cast metadata; encodeCursorFromRow is the
      // tested contract.
      expect(typeof r.result.encodeCursorFromRow).toBe("function");
    }
  });

  test("handles null in cursor sort values (was P2 — would skip rows)", () => {
    // Codex chunk-1B regression: null in cursor sort value caused tuple
    // comparison to evaluate to UNKNOWN and skip rows.
    const r = compileSort([{ fieldId: "fld_b", direction: "asc" }], fields, { values: [null], id: recordId });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.cursorWhere).not.toBeNull();
  });

  test("DESC NULLS FIRST with null cursor still emits a cursor predicate", () => {
    // Codex follow-up: this case used to return FALSE for orderGt and stop
    // pagination at the null tier instead of advancing into non-null rows.
    const r = compileSort([{ fieldId: "fld_b", direction: "desc", nullsFirst: true }], fields, {
      values: [null],
      id: recordId,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.result.cursorWhere).not.toBeNull();
  });

  test("encodes shared typed projections into the existing record cursor shape", () => {
    const compiled = compileSort([{ fieldId: "fld_b", direction: "desc" }], fields, null);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(normalizedSql(compiled.result.cursorSelect)).toContain("AS __gql_cursor_0");
    expect(normalizedSql(compiled.result.orderBy)).toContain("r.id DESC NULLS LAST");
    expect(decodeCursor(compiled.result.encodeCursorFromRow({ id: recordId, __gql_cursor_0: "12.500" }))).toEqual({
      values: ["12.500"],
      id: recordId,
    });
  });

  test("rejects malformed typed cursors before building executable SQL", () => {
    for (const value of ["not-a-number", {}, true, "1e131072"]) {
      expect(compileSort([{ fieldId: "fld_b", direction: "asc" }], fields, { values: [value], id: recordId })).toEqual({
        ok: false,
        error: "cursor values do not match this query ordering",
      });
    }
    expect(compileSort([], fields, { values: [], id: "not-a-uuid" }).ok).toBe(false);
    expect(compileSort([{ fieldId: "fld_b", direction: "asc" }], fields, { values: [], id: recordId }).ok).toBe(false);
  });
});

describe("cursor decode", () => {
  // Encoding moved to CompiledSort.encodeCursorFromRow which reads SQL
  // result rows; here we only test the decoder which is still pure.
  // We hand-build tokens with the same shape the encoder produces.
  const validUuid = "11111111-2222-3333-4444-555555555555";
  const tokenFor = (values: unknown[], id: string) => JSON.stringify({ v: values, i: id });

  test("decodes a valid token", () => {
    const decoded = decodeCursor(tokenFor(["foo", 42], validUuid));
    expect(decoded).toEqual({ values: ["foo", 42], id: validUuid });
  });

  test("returns null for malformed token", () => {
    expect(decodeCursor("null")).toBeNull();
    expect(decodeCursor("42")).toBeNull();
    expect(decodeCursor("not json")).toBeNull();
    expect(decodeCursor('{"only": "object"}')).toBeNull();
    expect(decodeCursor('{"v": "not array", "i": "x"}')).toBeNull();
  });

  test("returns null when id is not a UUID (no SQL cast crash on page 2)", () => {
    expect(decodeCursor(tokenFor([], "not-a-uuid"))).toBeNull();
    expect(decodeCursor(tokenFor([], "abc-123"))).toBeNull();
  });

  test("rejects mismatched length when expectedLength is given", () => {
    expect(decodeCursor(tokenFor(["a", "b"], validUuid), 1)).toBeNull();
    expect(decodeCursor(tokenFor(["a", "b"], validUuid), 2)).not.toBeNull();
  });
});
