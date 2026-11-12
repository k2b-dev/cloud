import { describe, expect, test } from "bun:test";
import { incomingAutomationMandateCaller } from "./incoming-automation-workload";

describe("incoming automation mandate caller", () => {
  test("supplies only mandate coordinates without acquiring reusable authority", () => {
    expect(incomingAutomationMandateCaller({ id: "10ec1c74-858b-4a98-9ba7-ab2276754c69", revision: 4 })).toEqual({
      mandate: { id: "10ec1c74-858b-4a98-9ba7-ab2276754c69", revision: 4, callingAppId: "mail" },
    });
  });
  test.each([0, -1, 1.5, NaN])("fails closed for invalid mandate revision %s", (revision) => {
    expect(() => incomingAutomationMandateCaller({ id: "test-mandate", revision })).toThrow(
      "This automation has no active Spaces authorization",
    );
  });
});
