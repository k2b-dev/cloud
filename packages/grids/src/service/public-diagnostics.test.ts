import { expect, test } from "bun:test";
import { publicDiagnosticMessage, publicDiagnosticValue } from "./public-diagnostics";

test("diagnostics retain useful public references without echoing storage UUIDs", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  expect(publicDiagnosticMessage(`Missing record ${id}; input Rec001`)).toBe("Missing record …; input Rec001");
  expect(publicDiagnosticValue({ message: `Field ${id}`, details: [{ [id]: id }], code: "BAD_INPUT" })).toEqual({
    message: "Field …",
    details: [{ "…": "…" }],
    code: "BAD_INPUT",
  });
});
