import { expect, test } from "bun:test";
import { SETTINGS_MAP, validateSettingValue } from "../services/settings/defaults";
import { AiRunTimeout } from "./run-timeout";
import { AiTodoPlanSchema, parseAiTodoPlan } from "./todo-contracts";

test("working plans reject ambiguous identities and concurrent active steps", () => {
  const active = { id: "inspect", content: "Inspect input", status: "in_progress" };
  expect(AiTodoPlanSchema.safeParse({ todos: [active, active] }).success).toBe(false);
  expect(AiTodoPlanSchema.safeParse({ todos: [active, { ...active, id: "build" }] }).success).toBe(false);
  expect(parseAiTodoPlan({ todos: [{ ...active, status: "pending" }] })).toEqual({ todos: [{ ...active, status: "pending" }] });
  expect(parseAiTodoPlan({ todos: [] })).toEqual({ todos: [] });
  expect(parseAiTodoPlan({ todos: [{ ...active, content: " " }] })).toBeUndefined();
});
test("admin budget defaults to 30 and accepts explicit unlimited but not invalid numbers", () => {
  const setting = SETTINGS_MAP.get("ai.turn_timeout_minutes")!;
  expect(setting.default).toBe(30);
  expect(validateSettingValue(setting, 0)).toMatchObject({ ok: true, value: 0 });
  expect(validateSettingValue(setting, -1).ok).toBe(false);
  expect(validateSettingValue(setting, 0.5).ok).toBe(false);
  expect(validateSettingValue(setting, Infinity).ok).toBe(false);
});
test("deadline messages name the actual budget and continuation", () => {
  expect(new AiRunTimeout(30 * 60_000).messageFor("de")).toContain("30 Minuten");
  expect(new AiRunTimeout(60_000).messageFor("en")).toContain("new message");
});
