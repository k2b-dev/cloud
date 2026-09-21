import { expect, test } from "bun:test";
import { documentConfirmationFromDependency } from "./query-contracts";

test("only a matching public confirmation reference is projected from kernel dependency data", () => {
  const data = { receiptId: "Doc001", sha256: "a".repeat(64) };
  const dependency = { kind: "grids.document-confirmation", key: "Doc001", data };
  expect(documentConfirmationFromDependency(dependency)).toEqual(data);
  for (const value of [
    null,
    {},
    { ...dependency, key: "Doc002" },
    { ...dependency, kind: "other" },
    { ...dependency, data: { ...data, receiptId: "Unknown record" } },
    { ...dependency, data: { ...data, sha256: "wrong" } },
    { ...dependency, data: { ...data, rows: ["private"] } },
  ])
    expect(documentConfirmationFromDependency(value)).toBeUndefined();
});
