import { describe, expect, test } from "bun:test";
import { compile } from "../service/custom-apps";
import { customAppDiagnostic } from "./diagnostics";

describe("custom App diagnostics", () => {
  test("keeps stable codes while resolving de-CH through German", () => {
    expect(customAppDiagnostic("de-CH", "field.missing", ["pages", 0], { fieldId: "FLD001" })).toEqual({
      code: "field.missing",
      path: ["pages", 0],
      message: "Das Feld FLD001 fehlt oder gehört zu einer anderen Tabelle.",
    });
  });

  test("falls back deterministically to English", () => {
    expect(customAppDiagnostic("fr", "query.invalid", ["source"])).toEqual({
      code: "query.invalid",
      path: ["source"],
      message: "The GQL query is invalid.",
    });
  });

  test("the compiler returns localized messages with stable codes", async () => {
    const result = await compile({}, undefined, "de-CH");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]).toMatchObject({
      code: "schema.invalid",
      message: "Die Definition der Grids-App enthält einen ungültigen Wert.",
    });
  });
});
