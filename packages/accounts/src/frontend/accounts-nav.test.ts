import { describe, expect, test } from "bun:test";
import { accountsNavItems, accountsNavigationItems } from "./accounts-nav";
import { accountsMessages } from "./messages";

const { t } = accountsMessages.resolve(["en"]);
const OVERVIEW = "/app/accounts";

describe("Accounts navigation", () => {
  test("the overview is an administrator's entry; everyone else starts at the groups", () => {
    const hrefs = (isAdmin: boolean) =>
      accountsNavItems(() => t, { active: "groups", pendingRequests: 0, isAdmin })
        .general()
        .map((item) => item.href);
    expect(hrefs(true)).toEqual([OVERVIEW, "/app/accounts/groups"]);
    expect(hrefs(false)).toEqual(["/app/accounts/groups"]);
  });

  test("the v2 sidebar leaves `isAdmin` out on administrators' pages: the overview stays there", () => {
    const items = accountsNavItems(() => t, { active: "users", pendingRequests: 0 }).general();
    expect(items.map((item) => item.href)).toContain(OVERVIEW);
  });

  test("the phone's app menu shows the overview and the administration to administrators only", () => {
    const ids = (isAdmin: boolean) =>
      accountsNavigationItems(t, { active: "groups", pendingRequests: 2, isAdmin }).map((item) => item.id);
    expect(ids(true)).toEqual([OVERVIEW, "/app/accounts/groups", "admin"]);
    expect(ids(false)).toEqual(["/app/accounts/groups"]);
  });
});
