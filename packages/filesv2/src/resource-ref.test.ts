import { expect, test } from "bun:test";
import { entryRefId, parseEntryRefId, parseStableEntryRefId, stableEntryRefId } from "./resource-ref";

test("entry references roundtrip Unicode and newline names", () => {
  const path = "Dokumente/🍎ä\nnotes.txt";
  expect(parseEntryRefId(entryRefId("cloud:home:user", path)!)).toEqual({ baseId: "cloud:home:user", path });
});

test("long references require the durable resolver; malformed inline IDs fail closed", () => {
  expect(entryRefId("base", "long/".repeat(100))).toBeNull();
  expect(parseEntryRefId("x".repeat(513))).toBeNull();
  expect(parseEntryRefId("p:" + "a".repeat(64))).toBeNull();
  expect(parseEntryRefId("/w")).toBeNull();
  expect(parseEntryRefId("YQpi=")).toBeNull();
  expect(parseEntryRefId("YQpic")).toBeNull();
});

test("stable refs name a base and a Filegate file ID and never collide with path refs", () => {
  const baseId = "cloud:groups:6f1c2e4a-1b2c-4d3e-8f90-1234567890ab";
  const fileId = "019b72cf-5200-7000-8000-000000000001";
  const id = stableEntryRefId(baseId, fileId)!;
  expect(id).toBe(`n:${baseId}:${fileId}`);
  expect(parseStableEntryRefId(id)).toEqual({ baseId, fileId });
  // Base64url has no colon, so a stable ref is never an inline ref, and inline or persisted refs are never stable ones.
  expect(parseEntryRefId(id)).toBeNull();
  expect(parseStableEntryRefId(entryRefId(baseId, "Docs/a.txt")!)).toBeNull();
  expect(parseStableEntryRefId(`p:${"a".repeat(64)}`)).toBeNull();
});

test("only canonical stable refs are minted or accepted", () => {
  const baseId = "freeipa:users:6f1c2e4a-1b2c-4d3e-8f90-1234567890ab";
  const fileId = "019b72cf-5200-7000-8000-000000000001";
  for (const invalid of [
    `n:${baseId}:${fileId.toUpperCase()}`,
    `n:${baseId.toUpperCase()}:${fileId}`,
    `n:cloud:home:6f1c2e4a-1b2c-4d3e-8f90-1234567890ab:${fileId}`,
    `n:${baseId}:${fileId}/x`,
    `n:${baseId}:${fileId}:extra`,
    `n:${baseId}`,
    `x${`n:${baseId}:${fileId}`}`,
  ])
    expect(parseStableEntryRefId(invalid)).toBeNull();
  expect(stableEntryRefId(baseId, "not-a-uuid")).toBeNull();
  expect(stableEntryRefId("cloud:users:someone", fileId)).toBeNull();
});
