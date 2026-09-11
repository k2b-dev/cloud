import { expect, test } from "bun:test";
import { ModalRequest } from "./modal-schema";
import { validateModalResponse } from "./modal-response";

test("agent dialog answers enforce the same field constraints and cancellation", () => {
  const request = ModalRequest.parse({ kind: "dialog", title: "Add", fields: {
    name: { type: "text", label: "Name", required: true, maxLength: 8 },
    count: { type: "number", label: "Count", min: 1 },
    choice: { type: "select", label: "Choice", options: [{ value: "one", label: "One" }] },
  } });
  expect(validateModalResponse(request, null)).toBeNull();
  const valid = { name: "Test", count: 2, choice: "one" };
  expect(structuredClone(validateModalResponse(request, valid))).toEqual(valid);
  for (const value of [{ ...valid, count: -1 }, { ...valid, name: " " }, { ...valid, choice: "absent" }, { ...valid, extra: true }])
    expect(() => validateModalResponse(request, value)).toThrow();
});

test("confirm requires boolean and optional numeric field preserves zero", () => {
  expect(() => validateModalResponse(ModalRequest.parse({ kind: "confirm", title: "Sure?", message: "Proceed?" }), "yes")).toThrow();
  expect(validateModalResponse(ModalRequest.parse({ kind: "number", title: "Number", label: "Value" }), 0)).toBe(0);
});
