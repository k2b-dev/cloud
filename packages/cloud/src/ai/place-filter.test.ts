import { expect, test } from "bun:test";
import { AiConversationPlaceFilterSchema } from "./place-filter";

test("place list filters use resource-reference validation and preserve colons in IDs", () => {
  for (const value of ["none", "any", "fixture.conversation:Marta1", "fixture.conversation:tenant:42"] as const) {
    expect(AiConversationPlaceFilterSchema.parse(value)).toBe(value);
  }
  for (const value of [
    "",
    "all",
    "fixture",
    "fixture.conversation:",
    ":Marta1",
    "bad type:42",
    "fixture.conversation:" + "a".repeat(513),
  ]) {
    expect(AiConversationPlaceFilterSchema.safeParse(value).success).toBe(false);
  }
});
