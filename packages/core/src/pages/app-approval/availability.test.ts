import { expect, test } from "bun:test";
import { approvalAvailability, useAppSignIn } from "./availability";

test("activation, incomplete setup, configuration and read failures remain distinct", () => {
  expect(approvalAvailability(null)).toBe("unavailable");
  expect(approvalAvailability({ enabled: false, appOrigin: "" })).toBe("disabled");
  expect(approvalAvailability({ enabled: true, appOrigin: "" })).toBe("setup-required");
  expect(approvalAvailability({ enabled: true, appOrigin: "https://auth.example.test" })).toBe("configured");
});

test("app is the default for full accounts, email for guests, with explicit fallbacks", () => {
  for (const category of ["login", "freeipa"]) {
    expect(useAppSignIn(true, null, category)).toBe(true);
    expect(useAppSignIn(true, "legacy", category)).toBe(false);
    expect(useAppSignIn(false, "app", category)).toBe(false);
  }
  expect(useAppSignIn(true, null, "guest")).toBe(false);
  expect(useAppSignIn(true, "app", "guest")).toBe(true);
});
