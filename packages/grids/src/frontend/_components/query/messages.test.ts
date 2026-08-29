import { describe, expect, test } from "bun:test";
import { GRID_FORMULA_FUNCTIONS } from "../../../formula/function-catalog";
import { queryMessages } from "./messages";

describe("queryMessages", () => {
  test("localizes every formula description shown in the GQL reference", () => {
    const { t } = queryMessages.resolve(["de-CH"]);
    for (const fn of GRID_FORMULA_FUNCTIONS) expect(t.functionDescription({ description: fn.description })).not.toBe(fn.description);
  });
});
