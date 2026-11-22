import Big from "big.js";
import type { z } from "zod";
import { fail, ok, type Result, type ServiceError } from "../result";

export type FinanceIssue = {
  code: "unsupported_format" | "input_limit" | "invalid_input" | "invalid_xml" | "schema_mismatch" | "schema_integrity" | "validator_unavailable";
  /** Input path; array indices are zero-based. XML-only errors use ["xml"]. */
  path: (string | number)[];
  message: string;
  /** One-based XML source location, when supplied by the validator. */
  line?: number;
  column?: number;
};
export type FinanceError = ServiceError<"BAD_INPUT" | "INTERNAL"> & { issues: FinanceIssue[] };
export type FinanceResult<T> = Result<T, FinanceError>;

export function invalid(issues: FinanceIssue[], internal = false): FinanceResult<never> {
  return fail({ code: internal ? "INTERNAL" : "BAD_INPUT", status: internal ? 500 : 400,
    message: internal ? "Financial format validation is unavailable." : "Invalid financial format input.", issues });
}

export function validate<T>(schema: z.ZodType<T>, input: unknown): FinanceResult<T> {
  const checked = schema.safeParse(input);
  if (checked.success) return ok(checked.data);
  return invalid(checked.error.issues.flatMap(issue => {
    const path = issue.path.map(part => typeof part === "symbol" ? String(part) : part);
    // Zod reports unknown keys at their parent. Preserve the actual field name.
    const paths = issue.code === "unrecognized_keys" ? issue.keys.map(key => [...path, key]) : [path];
    return paths.map(path => ({ code: "invalid_input" as const, path, message: issue.message }));
  }));
}

const Decimal = Big();
/** Exact addition of validated, fixed-cent strings; no precision setting or rounding. */
export function total(amounts: readonly string[]): string {
  return amounts.reduce((sum, amount) => sum.plus(amount), new Decimal(0)).toFixed(2);
}
