import { expect, test } from "bun:test";
import { approvalAvailability, useAppSignIn } from "./availability";

test("activation, incomplete setup, configuration and read failures remain distinct", () => {
  expect(approvalAvailability(null)).toBe("unavailable");
  expect(approvalAvailability({ enabled: false, appOrigin: "" })).toBe("disabled");
  expect(approvalAvailability({ enabled: true, appOrigin: "" })).toBe("setup-required");
  expect(approvalAvailability({ enabled: true, appOrigin: "https://auth.example.test" })).toBe("configured");
});

test("enabling app sign-in does not strand unpaired users or replace their default method", () => {
  for (const credential of [null, "legacy", "unknown"]) expect(useAppSignIn(true, credential)).toBe(false);
  expect(useAppSignIn(true, "app")).toBe(true);
  expect(useAppSignIn(false, "app")).toBe(false);
});
