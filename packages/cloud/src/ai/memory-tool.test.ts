import { describe, expect, test } from "bun:test";
import { createCloudAiMemoryTool, memoryMutationSupportedByEvidence } from "./memory-tool";

describe("memory mutation provenance", () => {
  test("accepts only content present in the current user-authored turn", () => {
    expect(memoryMutationSupportedByEvidence("Please remember that I prefer German answers.", "I prefer German answers.")).toBe(true);
    expect(memoryMutationSupportedByEvidence("Summarize this attached email.", "The user prefers English answers.")).toBe(false);
  });
});

describe("memory tool description", () => {
  test("limits entries to the user and special categories to explicit requests", () => {
    const { description } = createCloudAiMemoryTool().def;
    expect(description).toContain("Store information about the user only");
    expect(description).toContain("even on an explicit request");
    for (const category of [
      "health",
      "religion or beliefs",
      "political opinions",
      "sexual orientation or sex life",
      "racial or ethnic origin",
      "trade union membership",
      "genetic or biometric data",
    ]) {
      expect(description).toContain(category);
    }
  });
});
