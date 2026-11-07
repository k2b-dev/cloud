import { expect, test } from "bun:test";
import type { SettingDef } from "./defaults";
import { envSettingStatus } from "./env-status";

const def = (raw: unknown) =>
  ({
    key: "test.secret",
    kind: "secret",
    default: "",
    group: "test",
    description: "",
    envVariable: "TEST_SECRET",
    envBootstrap: () => raw,
  }) satisfies SettingDef;
test("status reports presence and conflicts without exposing secret values", () => {
  const row = envSettingStatus(def("secret-env"), { stored: "readable", value: "secret-stored" });
  expect(row).toMatchObject({ storedValuePresent: true, envValuePresent: true, conflict: "differs", needsAttention: true });
  expect(JSON.stringify(row)).not.toContain("secret-env");
  expect(JSON.stringify(row)).not.toContain("secret-stored");
  expect(envSettingStatus(def("same"), { stored: "readable", value: "same" }).needsAttention).toBe(false);
  expect(envSettingStatus(def("1"), { stored: "readable", value: "1.0" }).conflict).toBe("differs");
  expect(envSettingStatus(def(undefined), { stored: "none", value: "" }).needsAttention).toBe(false);
  expect(envSettingStatus(def("value"), { stored: "none", value: "" }).needsAttention).toBe(true);
});
test("unreadable stored values and invalid env values never appear healthy", () => {
  expect(envSettingStatus(def("secret"), { stored: "unreadable", value: "fallback" })).toMatchObject({
    conflict: "unknown",
    unreadableStoredValue: true,
    needsAttention: true,
  });
  expect(
    envSettingStatus(
      {
        ...def(undefined),
        envBootstrap: () => {
          throw new Error("secret");
        },
      },
      { stored: "none", value: "" },
    ),
  ).toMatchObject({ envValuePresent: true, invalidEnvValue: true, needsAttention: true });
  expect(envSettingStatus({ ...def(0), kind: "number", default: 1, min: 1 }, { stored: "none", value: 1 }).invalidEnvValue).toBe(true);
});
test("budget JSON comparison ignores object key order", () => {
  expect(
    envSettingStatus({ ...def('{"b":2,"a":1}'), key: "ai.workflow_budget", kind: "text" }, { stored: "readable", value: '{"a":1,"b":2}' })
      .conflict,
  ).toBe("none");
});
