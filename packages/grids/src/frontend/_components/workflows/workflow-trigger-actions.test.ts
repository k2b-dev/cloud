import { describe, expect, test } from "bun:test";
import type { WorkflowIrInput } from "@k2b/cloud/workflows";
import { buildWorkflowRunInput, workflowInputDraftFromValues } from "./workflow-trigger-actions";

describe("workflow run inputs", () => {
  test("localizes exact decimal input without rounding and rejects malformed numbers", () => {
    const inputs = [{ name: "amount", type: "decimal", config: { required: true } }];
    expect(buildWorkflowRunInput(inputs, { amount: "9007199254740993,25" }, "de")).toEqual({
      ok: true,
      input: { amount: "9007199254740993.25" },
    });
    expect(buildWorkflowRunInput(inputs, { amount: ",5" }, "de")).toEqual({ ok: true, input: { amount: "0.5" } });
    expect(buildWorkflowRunInput(inputs, { amount: "0012.50" }, "en")).toEqual({ ok: true, input: { amount: "12.5" } });
    for (const amount of ["1.234,56", "1,234.56", "NaN", "Infinity", "0x10", "1e131072", "1e-16384", 12.5]) {
      expect(buildWorkflowRunInput(inputs, { amount }, "de").ok).toBe(false);
    }
  });

  test("requires declared inputs and preserves typed values", () => {
    const inputs: WorkflowIrInput[] = [
      { name: "loan", type: "record", config: { table: "Loans", label: "Loan", required: true } },
      { name: "notify", type: "boolean", config: { required: true } },
      { name: "amount", type: "number", config: {} },
    ];

    expect(buildWorkflowRunInput(inputs, {})).toEqual({
      ok: false,
      errors: { loan: "Loan is required.", notify: "notify is required." },
    });
    expect(buildWorkflowRunInput(inputs, {}, "de-CH")).toEqual({
      ok: false,
      errors: { loan: "Loan ist erforderlich.", notify: "notify ist erforderlich." },
    });
    expect(buildWorkflowRunInput(inputs, { loan: "record-id", notify: false, amount: 12.5 })).toEqual({
      ok: true,
      input: { loan: "record-id", notify: false, amount: 12.5 },
    });
  });

  test("omits empty optional inputs instead of inventing values", () => {
    expect(
      buildWorkflowRunInput(
        [
          { name: "note", type: "text", config: {} },
          { name: "records", type: "recordList", config: { table: "Loans" } },
        ],
        { note: "", records: [] },
      ),
    ).toEqual({
      ok: true,
      input: {},
    });
  });

  test("hydrates editable input values and ignores unsupported stored shapes", () => {
    const inputs: WorkflowIrInput[] = [
      { name: "range", type: "select", config: {} },
      { name: "records", type: "recordList", config: {} },
      { name: "metadata", type: "text", config: {} },
    ];

    expect(
      workflowInputDraftFromValues(inputs, {
        range: "30d",
        records: ["one", "two"],
        metadata: { unsupported: true },
        stale: "ignored",
      }),
    ).toEqual({ range: "30d", records: ["one", "two"] });
  });
});
