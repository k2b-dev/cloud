import { describe, expect, spyOn, test } from "bun:test";
import * as services from "@k2b/cloud/services";
import { incomingAutomationMandateCaller } from "./incoming-automation-workload";
import { mailWorkflowActionFailure } from "./workflow-action-errors";

describe("incoming automation mandate caller", () => {
  test("uses only the app workload credential and current mandate coordinates", () => {
    expect(incomingAutomationMandateCaller({ id: "10ec1c74-858b-4a98-9ba7-ab2276754c69", revision: 4 }, " app-secret ")).toEqual({
      authorization: "Bearer app-secret",
      mandate: { id: "10ec1c74-858b-4a98-9ba7-ab2276754c69", revision: 4, callingAppId: "mail" },
    });
  });

  test("uses the runtime accessor without an env credential", () => {
    const accessor = spyOn(services, "getAppWorkloadCredential").mockReturnValue("runtime-token");
    try {
      expect(incomingAutomationMandateCaller({ id: "test-mandate", revision: 1 }).authorization).toBe("Bearer runtime-token");
      expect(accessor).toHaveBeenCalledTimes(1);
    } finally {
      accessor.mockRestore();
    }
  });

  test("retries temporary runtime credential unavailability instead of ending an automation", () => {
    try {
      incomingAutomationMandateCaller({ id: "test-mandate", revision: 1 }, "");
      throw new Error("Expected missing workload credential");
    } catch (error) {
      expect(mailWorkflowActionFailure(error)).toMatchObject({ code: "WORKLOAD_AUTH_UNAVAILABLE", retryable: true });
    }
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
