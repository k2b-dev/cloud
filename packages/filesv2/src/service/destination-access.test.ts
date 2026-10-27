import { expect, test } from "bun:test";
import { destinationAccess } from "./destination-access";

test("describes effective readers without treating a masked ACL entry as access", () => {
  expect(
    destinationAccess(
      {
        entries: [
          { tag: "owner", permissions: "rwx" },
          { tag: "owningGroup", permissions: "r-x" },
          { tag: "user", id: 1002, permissions: "rwx" },
          { tag: "group", id: 2002, permissions: "r-x" },
          { tag: "mask", permissions: "r--" },
          { tag: "other", permissions: "r-x" },
        ],
      },
      "Team",
    ),
  ).toEqual({
    kind: "filesystem",
    name: "Team",
    owner: true,
    group: false,
    additionalUsers: 0,
    additionalGroups: 0,
    others: true,
  });
});
test("preserves group and named reader consequences when their effective rights allow browsing", () => {
  expect(
    destinationAccess(
      {
        entries: [
          { tag: "owner", permissions: "rwx" },
          { tag: "owningGroup", permissions: "r-x" },
          { tag: "user", id: 1002, permissions: "rwx" },
          { tag: "group", id: 2002, permissions: "r-x" },
          { tag: "mask", permissions: "r-x" },
          { tag: "other", permissions: "---" },
        ],
      },
      "Team",
    ),
  ).toMatchObject({ owner: true, group: true, additionalUsers: 1, additionalGroups: 1, others: false });
});
