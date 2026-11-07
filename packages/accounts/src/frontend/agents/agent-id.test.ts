import { expect, test } from "bun:test";
import { agentIdFromPath } from "./agent-id";

test("only a UUID reaches the agent lookup", () => {
  expect(agentIdFromPath("0b2f5c7e-0000-4000-8000-0000000000bb")).toBe("0b2f5c7e-0000-4000-8000-0000000000bb");
  expect(agentIdFromPath("-".repeat(36))).toBeNull();
  expect(agentIdFromPath("not-an-id")).toBeNull();
  expect(agentIdFromPath(undefined)).toBeNull();
});
