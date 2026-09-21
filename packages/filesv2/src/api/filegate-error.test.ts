import { expect, test } from "bun:test";
import { FilegateError } from "@k2b/filegate";
import { filegateErrorCode } from "./filegate-error";

test("only a confirmed path conflict offers overwrite; identity and concurrency failures remain distinct", () => {
  for (const [status, code, expected] of [
    [409, "path_conflict", "path_conflict"],
    [409, "idempotency_conflict", "idempotency_conflict"],
    [409, "conflict", "operation_conflict"],
    [409, "cursor_invalid", "cursor_invalid"],
    [412, "precondition_failed", "write_conflict"],
    [403, "permission_denied", "forbidden"],
    [404, "not_found", "not_found"],
  ] as const)
    expect(filegateErrorCode(new FilegateError(status, code, "private upstream message"))).toBe(expected);
});
