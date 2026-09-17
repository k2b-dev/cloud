import { expect, test } from "bun:test";
import type { ACL, Node } from "@k2b/filegate";
import { permits } from "./posix";

const node: Node = { root: "freeipa", path: "groups/team", directory: true, size: 0, modified: "", mode: "2770", uid: 1001, gid: 2001 };
const acl: ACL = {
  entries: [
    { tag: "owner", permissions: "rwx" },
    { tag: "owningGroup", permissions: "r-x" },
    { tag: "other", permissions: "---" },
  ],
};
test("owner and group identities use genuine distinct UID/GID", () => {
  expect(permits(node, acl, { uid: 1001, gids: new Set([99]) }, 5)).toBeTrue();
  expect(permits(node, acl, { uid: 1002, gids: new Set([2001]) }, 5)).toBeTrue();
  expect(permits(node, acl, { uid: 2001, gids: new Set([99]) }, 5)).toBeFalse();
});
test("named user wins over groups and ACL mask restricts it", () => {
  const named: ACL = { entries: [...acl.entries, { tag: "user", id: 1002, permissions: "rwx" }, { tag: "mask", permissions: "r--" }] };
  expect(permits(node, named, { uid: 1002, gids: new Set([2001]) }, 5)).toBeFalse();
  expect(permits(node, named, { uid: 1002, gids: new Set([2001]) }, 4)).toBeTrue();
});
test("matching group entries cannot combine read and execute", () => {
  const split: ACL = {
    entries: [
      { tag: "owner", permissions: "rwx" },
      { tag: "owningGroup", permissions: "r--" },
      { tag: "group", id: 2002, permissions: "--x" },
      { tag: "mask", permissions: "rwx" },
      { tag: "other", permissions: "rwx" },
    ],
  };
  expect(permits(node, split, { uid: 1002, gids: new Set([2001, 2002]) }, 5)).toBeFalse();
  expect(permits(node, split, { uid: 1002, gids: new Set([2001, 2002]) }, 4)).toBeTrue();
});
