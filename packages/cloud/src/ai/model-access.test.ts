import { describe, expect, test } from "bun:test";
import type { Principal } from "../contracts/shared";
import { splitAiModelAccess } from "./model-access";

const profiles = ["open", "limited"].map((id) => ({ id, label: id, provider: "ollama", model: id }));
const draft = <T extends Principal>(principal: T) => ({ principal, permission: "read" as const });

describe("model permission draft transport", () => {
  test("removes drafts from persisted provider JSON", () => {
    const input = { ...profiles[0], assistantAccess: { expectedRevision: null, entries: [draft({ type: "authenticated" })] } };
    const result = splitAiModelAccess(JSON.stringify([input]));
    expect(JSON.parse(result.profilesJson)).toEqual([profiles[0]]);
    expect(result.changes).toEqual([{ profileId: "open", ...input.assistantAccess }]);
  });
  test("rejects public, elevated permissions and unrecognized metadata", () => {
    for (const entries of [
      [draft({ type: "public" })],
      [{ principal: { type: "authenticated" }, permission: "admin" }],
      [{ ...draft({ type: "authenticated" }), displayName: "spoof" }],
    ]) {
      expect(() =>
        splitAiModelAccess(JSON.stringify([{ ...profiles[0], assistantAccess: { expectedRevision: null, entries } }])),
      ).toThrow();
    }
  });
});
