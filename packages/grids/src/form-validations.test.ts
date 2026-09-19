import { describe, expect, test } from "bun:test";
import type { FormValidationRule } from "./contracts";
import { evaluateFormValidations, formValidationFieldsCompatible } from "./form-validations";
import type { Field } from "./service";

const field = (id: string, name: string, type: string, config: Record<string, unknown> = {}): Field =>
  ({ id, shortId: id.slice(0, 6), tableId: "table", name, type, config, required: false, deletedAt: null }) as Field;

const start = field("11111111-1111-4111-8111-111111111111", "Start", "date");
const due = field("22222222-2222-4222-8222-222222222222", "Due", "date");
const amount = field("33333333-3333-4333-8333-333333333333", "Amount", "number");
const rule: FormValidationRule = {
  leftFieldId: start.id,
  operator: "lte",
  rightFieldId: due.id,
  message: "Start must be on or before Due.",
};

describe("Form cross-field validation", () => {
  test("compares compatible normalized values and binds failures to the left field", () => {
    const fields = new Map([start, due].map((item) => [item.id, item]));
    expect(evaluateFormValidations([rule], { [start.id]: "2026-08-14", [due.id]: "2026-08-13" }, fields)).toEqual([
      { ...rule, errorFieldId: start.id },
    ]);
    expect(evaluateFormValidations([rule], { [start.id]: "2026-08-13", [due.id]: "2026-08-13" }, fields)).toEqual([]);
  });

  test("leaves empty and invalid typed values to field validation", () => {
    const fields = new Map([start, due].map((item) => [item.id, item]));
    expect(evaluateFormValidations([rule], { [start.id]: "", [due.id]: "2026-08-13" }, fields)).toEqual([]);
    expect(evaluateFormValidations([rule], { [start.id]: "not-a-date", [due.id]: "2026-08-13" }, fields)).toEqual([]);
    expect(evaluateFormValidations([rule], { [start.id]: "2026-02-31", [due.id]: "2026-08-13" }, fields)).toEqual([]);
  });

  test("accepts numeric families but keeps numbers and dates incompatible", () => {
    expect(formValidationFieldsCompatible(amount, field("44444444-4444-4444-8444-444444444444", "Duration", "duration"))).toBe(false);
    expect(formValidationFieldsCompatible(amount, start)).toBe(false);
    expect(formValidationFieldsCompatible(start, field("55555555-5555-4555-8555-555555555555", "At", "date", { includeTime: true }))).toBe(
      false,
    );
  });

  test("compares decimal strings exactly and duration shorthand by seconds", () => {
    const limit = field("44444444-4444-4444-8444-444444444444", "Limit", "number");
    const duration = field("55555555-5555-4555-8555-555555555555", "Duration", "duration");
    const maximum = field("66666666-6666-4666-8666-666666666666", "Maximum", "duration");
    const numericRule = { ...rule, leftFieldId: amount.id, rightFieldId: limit.id, operator: "gt" as const };
    const durationRule = { ...rule, leftFieldId: duration.id, rightFieldId: maximum.id, operator: "lte" as const };

    expect(
      evaluateFormValidations(
        [numericRule],
        { [amount.id]: "9007199254740993", [limit.id]: "9007199254740992" },
        new Map([
          [amount.id, amount],
          [limit.id, limit],
        ]),
      ),
    ).toEqual([]);
    expect(
      evaluateFormValidations(
        [durationRule],
        { [duration.id]: "01:30", [maximum.id]: "89" },
        new Map([
          [duration.id, duration],
          [maximum.id, maximum],
        ]),
      ),
    ).toEqual([{ ...durationRule, errorFieldId: duration.id }]);
    expect(
      evaluateFormValidations(
        [durationRule],
        { [duration.id]: "1:", [maximum.id]: "59" },
        new Map([
          [duration.id, duration],
          [maximum.id, maximum],
        ]),
      ),
    ).toEqual([{ ...durationRule, errorFieldId: duration.id }]);
  });
});

test("anyPresent requires a selection in either relation input, in both server and public-ID forms", () => {
  for (const prefix of ["", "public-"]) {
    const left = field(`${prefix}kits`, "Sets", "relation");
    const right = field(`${prefix}items`, "Items", "relation");
    const pair: FormValidationRule = {
      leftFieldId: left.id,
      rightFieldId: right.id,
      operator: "anyPresent",
      message: "Choose a set or item.",
    };
    const fields = new Map([left, right].map((item) => [item.id, item]));
    expect(formValidationFieldsCompatible(left, right, "anyPresent")).toBe(true);
    expect(formValidationFieldsCompatible(left, amount, "anyPresent")).toBe(false);
    expect(formValidationFieldsCompatible(left, right, "eq")).toBe(false);
    for (const values of [{}, { [left.id]: [], [right.id]: [] }, { [left.id]: null, [right.id]: "" }]) {
      expect(evaluateFormValidations([pair], values, fields)).toEqual([{ ...pair, errorFieldId: left.id }]);
    }
    for (const values of [{ [left.id]: ["KIT001"] }, { [right.id]: ["ITEM01"] }, { [left.id]: ["KIT001"], [right.id]: ["ITEM01"] }]) {
      expect(evaluateFormValidations([pair], values, fields)).toEqual([]);
    }
  }
});
