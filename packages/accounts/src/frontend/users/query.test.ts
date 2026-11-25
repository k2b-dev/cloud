import { describe, expect, test } from "bun:test";
import {
  directoryQueryOf,
  legacyUsersHref,
  loginWindow,
  parseUsersAddress,
  USER_VIEWS,
  userDetailHref,
  usersHref,
  usersListContext,
  usersListHref,
  usersQuery,
} from "./query";

const query = usersQuery("de");
const GROUP = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-25T12:00:00.000Z");
const parse = (text: string) => parseUsersAddress(query, new URLSearchParams(text));

describe("the user list's address", () => {
  test("holds every filter, the search, the sort and the grouping, and writes them back the same", () => {
    const text = `role=admin,member&member-of=${GROUP}&status=active&login=last-30d&passkey=no&provider=local&q=ada&sort=login.desc&group=member-of&page=2`;
    const address = parse(text);
    expect(address.issues).toEqual([]);
    expect(address.page).toBe(2);
    expect(address.state.filters).toEqual({
      role: ["admin", "member"],
      "member-of": [GROUP],
      status: ["active"],
      login: { kind: "preset", preset: "last-30d" },
      passkey: false,
      provider: "local",
    });
    expect(usersHref(query, address.state, address.page)).toBe(`/app/accounts/users?${text}`);
  });

  test("drops what the list cannot hold and says so, instead of cutting or guessing", () => {
    const address = parse(`q=${"x".repeat(201)}&member-of=not-a-group&role=owner&view=mine&page=0`);
    expect(address.state.search).toBeUndefined();
    expect(address.state.filters).toEqual({});
    expect(address.state.view).toBeUndefined();
    expect(address.page).toBe(1);
    expect(address.issues.map((issue) => issue.param).sort()).toEqual(["member-of", "page", "q", "role", "view"]);
  });

  test("allows at most 20 groups in one filter", () => {
    const ids = Array.from({ length: 21 }, (_, index) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`);
    expect(parse(`member-of=${ids.join(",")}`).state.filters["member-of"]).toBeUndefined();
    expect(parse(`member-of=${ids.slice(0, 20).join(",")}`).state.filters["member-of"]).toHaveLength(20);
  });

  test("the views in code are plain addresses", () => {
    expect(usersHref(query, USER_VIEWS["no-passkey"](query))).toBe("/app/accounts/users?view=no-passkey&status=active&passkey=no");
    expect(usersHref(query, USER_VIEWS["inactive-admins"](query))).toBe(
      "/app/accounts/users?view=inactive-admins&role=admin&login=older-90d",
    );
  });
});

describe("what the service is asked for", () => {
  test("maps the filters and the sort", () => {
    const { state } = parse(`role=guest&member-of=${GROUP}&status=invited,expired&passkey=yes&provider=ipa&q=lin&sort=name.desc`);
    expect(directoryQueryOf(state, "Europe/Berlin", NOW)).toEqual({
      search: "lin",
      roles: ["guest"],
      groupIds: [GROUP],
      statuses: ["invited", "expired"],
      lastLogin: undefined,
      passkey: true,
      provider: "ipa",
      sort: { field: "name", direction: "desc" },
    });
    expect(directoryQueryOf(parse("sort=login.asc").state, "UTC", NOW).sort).toEqual({ field: "lastLogin", direction: "asc" });
  });

  test("reads the last sign-in as instants: rolling presets from now, calendar days in the person's zone", () => {
    expect(loginWindow({ kind: "preset", preset: "last-7d" }, "UTC", NOW)).toEqual({ since: new Date("2026-11-18T12:00:00.000Z") });
    expect(loginWindow({ kind: "preset", preset: "older-90d" }, "UTC", NOW)).toEqual({ until: new Date("2026-08-27T12:00:00.000Z") });
    expect(loginWindow({ kind: "preset", preset: "never" }, "UTC", NOW)).toBe("never");
    // 1 to 30 November in Berlin: from midnight of the 1st (UTC+1) to midnight after the 30th
    expect(loginWindow({ kind: "range", from: "2026-11-01", to: "2026-11-30" }, "Europe/Berlin", NOW)).toEqual({
      since: new Date("2026-10-31T23:00:00.000Z"),
      until: new Date("2026-11-30T23:00:00.000Z"),
    });
    expect(loginWindow({ kind: "range", to: "2026-03-28" }, "Europe/Berlin", NOW)).toEqual({ until: new Date("2026-03-28T23:00:00.000Z") });
  });
});

describe("addresses from before v2", () => {
  test("lead to the same list: search became q, profile became the role, other parameters stay", () => {
    expect(legacyUsersHref(new URLSearchParams("search=ada&provider=ipa&profile=user&page=3"))).toBe(
      "/app/accounts/users?provider=ipa&page=3&q=ada&role=admin,member",
    );
    expect(legacyUsersHref(new URLSearchParams("profile=guest"))).toBe("/app/accounts/users?role=guest");
    expect(legacyUsersHref(new URLSearchParams("q=ada&role=admin"))).toBeNull();
  });
});

describe("a user's page and the list it came from", () => {
  test("a row carries the whole list address, and the page leads back to it", () => {
    const list = `role=admin&member-of=${GROUP}&group=member-of&page=2`;
    const href = userDetailHref("u-1", list);
    expect(href).toBe(`/app/accounts/users/u-1?list=${encodeURIComponent(list)}`);
    const context = usersListContext(query, new URL(href, "https://cloud.test").searchParams);
    expect(usersListHref(context)).toBe(`/app/accounts/users?${list}`);
  });

  test("an old link with the pre-v2 names, or none, still leads back to a list", () => {
    expect(usersListHref(usersListContext(query, new URLSearchParams("search=ada&profile=guest&page=2&recursive=true")))).toBe(
      "/app/accounts/users?role=guest&q=ada&page=2",
    );
    expect(usersListHref(usersListContext(query, new URLSearchParams("")))).toBe("/app/accounts/users");
  });

  test("a list context names only this list: other parameters fall away", () => {
    expect(usersListHref(usersListContext(query, new URLSearchParams({ list: "next=//evil.example&role=admin" })))).toBe(
      "/app/accounts/users?role=admin",
    );
  });
});
