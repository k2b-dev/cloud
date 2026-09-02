import { describe, expect, test } from "bun:test";
import { incomingAutomationMandateCaller } from "./incoming-automation-workload";

describe("incoming automation mandate caller", () => {
  test("uses only the app workload credential and current mandate coordinates", () => {
    expect(incomingAutomationMandateCaller({ id: "10ec1c74-858b-4a98-9ba7-ab2276754c69", revision: 4 }, " app-secret ")).toEqual({
      authorization: "Bearer app-secret",
      mandate: { id: "10ec1c74-858b-4a98-9ba7-ab2276754c69", revision: 4, callingAppId: "mail" },
    });
  });

  test("fails closed without runtime workload authority", () => {
    expect(() => incomingAutomationMandateCaller({ id: crypto.randomUUID(), revision: 1 }, " ")).toThrow(
      "Mail workload authorization is unavailable",
    );
    expect(() => incomingAutomationMandateCaller({ id: crypto.randomUUID(), revision: 0 }, "secret")).toThrow(
      "This automation has no active Spaces authorization",
    );
  });
});
