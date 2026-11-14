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

test("place chats publish a separate localized search category alongside ordinary chats", () => {
  const query = assistantCapabilities.queries["place.search"];
  expect(query.universalSearch.tags.map((entry) => entry.tag)).toEqual(["assistant-place", "chat"]);
  expect(assistantCapabilities.presentation.translations.de.queries["place.search"].title).toBe("An Orten");
});
