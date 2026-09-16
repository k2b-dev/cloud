import { expect, test } from "bun:test";
import { compileCapabilityManifest } from "@k2b/cloud/capabilities/testing";
import { assistantCapabilities } from "./capabilities";

test("publishes the linkable chat command with a valid input contract", () => {
  expect(() => compileCapabilityManifest("assistant", assistantCapabilities)).not.toThrow();
  const input = assistantCapabilities.commands["chat.compose"].input;
  expect(input.safeParse({}).success).toBe(true);
  expect(input.safeParse({ projectId: "Project01" }).success).toBe(true);
  expect(input.safeParse({ projectId: "" }).success).toBe(false);
  expect(input.safeParse({ prompt: "Start work" }).success).toBe(false);
});
