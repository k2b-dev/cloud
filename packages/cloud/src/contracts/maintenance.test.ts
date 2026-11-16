import { expect, test } from "bun:test";
import { type MaintenanceState, normalizeMaintenanceMessage, parseMaintenanceState } from "./maintenance";

const valid: MaintenanceState = {
  id: "8b0f5c1e-3b9a-4c55-9d0e-2f7a1c6b4e90",
  startedAt: Date.UTC(2026, 10, 16, 13, 2),
  startedBy: { id: "0b6f2e3c-6f0e-4d8e-9a77-3f1c2b9d4e51", label: "Lea Muster" },
  message: "Wir spielen Version 2.4 ein.",
  until: Date.UTC(2026, 10, 16, 13, 30),
  quiesce: false,
  bypassKey: "Ab-_".repeat(10).concat("xyz"),
};

test("a stored state reads back only when every field is valid", () => {
  expect(parseMaintenanceState(valid)).toEqual(valid);
  const { message: _message, until: _until, ...minimal } = valid;
  expect(parseMaintenanceState(minimal)).toEqual(minimal);
});

test.each([
  ["garbage", "on"],
  ["null", null],
  ["an array", [valid]],
  ["a missing bypass key", { ...valid, bypassKey: undefined }],
  ["a short bypass key", { ...valid, bypassKey: "abc" }],
  ["an overlong message", { ...valid, message: "x".repeat(501) }],
  ["an empty message", { ...valid, message: "" }],
  ["a non-integer start", { ...valid, startedAt: 1.5 }],
  ["a string end", { ...valid, until: "14:30" }],
  ["a missing quiesce flag", { ...valid, quiesce: undefined }],
])("%s reads as off, never as a broken state", (_label, value) => {
  expect(parseMaintenanceState(value)).toBeNull();
});

test("messages are trimmed and an empty message is none", () => {
  expect(normalizeMaintenanceMessage("  Hallo\r\nWelt  ")).toBe("Hallo\nWelt");
  expect(normalizeMaintenanceMessage("   ")).toBeUndefined();
  expect(normalizeMaintenanceMessage(undefined)).toBeUndefined();
});
