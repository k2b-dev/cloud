import { describe, expect, spyOn, test } from "bun:test";
import * as services from "@k2b/cloud/services";
import { incomingAutomationMandateCaller } from "./incoming-automation-workload";

describe("incoming automation mandate caller", () => {
  test("supplies only mandate coordinates without acquiring reusable authority", () => {
    const accessor = spyOn(services, "getAppWorkloadCredential").mockImplementation(() => {
      throw new Error("Mail must not acquire transport credentials");
    });
    try {
      expect(incomingAutomationMandateCaller({ id: "10ec1c74-858b-4a98-9ba7-ab2276754c69", revision: 4 })).toEqual({
        mandate: { id: "10ec1c74-858b-4a98-9ba7-ab2276754c69", revision: 4, callingAppId: "mail" },
      });
      expect(accessor).not.toHaveBeenCalled();
    } finally {
      accessor.mockRestore();
    }
  });
  test.each([0, -1, 1.5, NaN])("fails closed for invalid mandate revision %s", (revision) => {
    expect(() => incomingAutomationMandateCaller({ id: "test-mandate", revision })).toThrow(
      "This automation has no active Spaces authorization",
    );
  });
});
