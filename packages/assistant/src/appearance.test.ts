import { expect, test } from "bun:test";
import { app } from "./config";

// In Gustav plum is the primary colour (decided 07.11.2026); the scope comes from the declaration, not from overrides.
test("Gustav declares the AI colour as its primary", () => {
  expect(app.meta.appearance?.primary).toBe("ai");
});
