import { expect, test } from "bun:test";
import { diffJmapMemberships, orderJmapMemberships } from "./jmap-sync-runtime";

test("primary membership prefers Inbox then opaque text order without mutating input", () => {
  const folders = [
    { mailboxId: "z", role: "archive" },
    { mailboxId: "b", role: "inbox" },
    { mailboxId: "A", role: "other" },
    { mailboxId: "a", role: "inbox" },
  ];
  expect(
    orderJmapMemberships(folders).map((folder) => folder.mailboxId),
    "primary: inbox and text order",
  ).toEqual(["a", "b", "A", "z"]);
  expect(folders[0]?.mailboxId, "primary: original preserved").toBe("z");
  expect(orderJmapMemberships(folders.filter((folder) => folder.role !== "inbox"))[0]?.mailboxId, "primary: no inbox").toBe("A");
  expect(orderJmapMemberships([]), "primary: empty").toEqual([]);
});

test("membership difference deduplicates, keeps unchanged refs and describes moves and last removal", () => {
  expect(diffJmapMemberships(["b", "c", "c"], ["a", "b"]), "diff: move").toEqual({ add: ["c"], remove: ["a"] });
  expect(diffJmapMemberships(["a"], ["a"]), "diff: unchanged").toEqual({ add: [], remove: [] });
  expect(diffJmapMemberships([], ["a"]), "diff: last membership").toEqual({ add: [], remove: ["a"] });
  expect(diffJmapMemberships(["a"], []), "diff: initial").toEqual({ add: ["a"], remove: [] });
});
