import { expect, test } from "bun:test";
import { entryRefId, parseEntryRefId } from "./resource-ref";

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
