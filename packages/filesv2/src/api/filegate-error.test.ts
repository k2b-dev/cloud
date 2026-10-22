import { expect, test } from "bun:test";
import { FilegateError } from "@k2b/filegate";
import { filegateErrorCode } from "./filegate-error";
import { errorMessage, publicErrorMessage } from "./messages";

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

test("readable but unwritable folder parents have a distinct creation message in both locales", () => {
  expect(errorMessage("create_forbidden", "en")).toBe("You do not have permission to create folders here.");
  expect(errorMessage("create_forbidden", "de")).toBe("Du darfst hier keine Ordner anlegen.");
  for (const locale of ["en", "de"]) expect(errorMessage("create_forbidden", locale)).not.toBe(errorMessage("forbidden", locale));
});

test("unreadable configuration gives administrators recovery instructions", () => {
  expect(errorMessage("configuration_unreadable", "en")).toContain("Filegate token again");
  expect(errorMessage("configuration_unreadable", "de")).toContain("Filegate-Token erneut");
});

test("public share visitors receive an availability message instead of admin recovery steps", () => {
  expect(publicErrorMessage("configuration_unreadable", "en")).toBe("Files is not available right now. Ask an administrator.");
  expect(publicErrorMessage("configuration_unreadable", "de")).not.toContain("Token");
  expect(publicErrorMessage("not_found", "en")).toBe(errorMessage("not_found", "en"));
});
