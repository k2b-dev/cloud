import { describe, expect, test } from "bun:test";
import { derivePageTrail } from "./page-trail";

const start = { title: "Start", href: "/" };

describe("derivePageTrail", () => {
  test("drops Start and the app root, whether a page passes them or not", () => {
    const withBoth = derivePageTrail([start, { title: "Accounts", href: "/app/accounts" }, { title: "Users" }], "/app/accounts", "Cloud");
    const withNeither = derivePageTrail([{ title: "Users" }], "/app/accounts", "Cloud");
    expect(withBoth).toEqual({ title: "Users", ancestors: [] });
    expect(withNeither).toEqual(withBoth);
  });

  test("keeps the levels below the app root, nearest last, so their number is the depth", () => {
    expect(
      derivePageTrail(
        [
          start,
          { title: "Mail", href: "/app/mail" },
          { title: "Info mailbox", href: "/app/mail/m1" },
          { title: "Automations", href: "/app/mail/m1/automations" },
          { title: "Workflows" },
        ],
        "/app/mail",
        "Cloud",
      ),
    ).toEqual({
      title: "Workflows",
      ancestors: [
        { title: "Info mailbox", href: "/app/mail/m1" },
        { title: "Automations", href: "/app/mail/m1/automations" },
      ],
    });
  });

  test("compares the app root without a trailing slash or hash, but a query names another page", () => {
    const trail = derivePageTrail(
      [
        { title: "Assistant", href: "/app/assistant/#chat" },
        { title: "Apps", href: "/app/assistant?studio=1" },
        { title: "Budget planner" },
      ],
      "/app/assistant",
      "Cloud",
    );
    expect(trail).toEqual({ title: "Budget planner", ancestors: [{ title: "Apps", href: "/app/assistant?studio=1" }] });
  });

  test("an entry without a link is no level, because nobody can go back to it", () => {
    expect(
      derivePageTrail(
        [start, { title: "Accounts" }, { title: "Groups", href: "" }, { title: "Users", href: "/app/accounts/users" }, { title: "jdoe" }],
        "/app/accounts",
        "Cloud",
      ),
    ).toEqual({ title: "jdoe", ancestors: [{ title: "Users", href: "/app/accounts/users" }] });
  });

  test("an entry that links to the page itself is no level either", () => {
    const title = [{ title: "Bookshop", href: "/apps/shop" }, { title: "Catalog" }];
    expect(derivePageTrail(title, "/apps", "Cloud", "/apps/shop")).toEqual({ title: "Catalog", ancestors: [] });
    expect(derivePageTrail(title, "/apps", "Cloud", "/apps/shop/orders")).toEqual({
      title: "Catalog",
      ancestors: [{ title: "Bookshop", href: "/apps/shop" }],
    });
  });

  test("the last entry is always the page, even when it carries the app root's link", () => {
    expect(derivePageTrail([start, { title: "Mail", href: "/app/mail" }], "/app/mail", "Cloud")).toEqual({ title: "Mail", ancestors: [] });
  });

  test("a string title, no title, and pages outside an app", () => {
    expect(derivePageTrail("Settings", "/app/settings", "Cloud")).toEqual({ title: "Settings", ancestors: [] });
    expect(derivePageTrail(undefined, undefined, "Cloud")).toEqual({ title: "Cloud", ancestors: [] });
    expect(derivePageTrail([], undefined, "Cloud")).toEqual({ title: "Cloud", ancestors: [] });
    expect(
      derivePageTrail(
        [start, { title: "Account", href: "/me" }, { title: "Notifications", href: "/me/notifications" }, { title: "History" }],
        undefined,
        "Cloud",
      ),
    ).toEqual({
      title: "History",
      ancestors: [
        { title: "Account", href: "/me" },
        { title: "Notifications", href: "/me/notifications" },
      ],
    });
  });
});
