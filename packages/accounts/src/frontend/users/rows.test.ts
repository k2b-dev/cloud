import { expect, test } from "bun:test";
import type { UserDirectoryEntry } from "@k2b/cloud/contracts";
import { listMessages } from "../list-messages";
import { inSeveralGroups, lastLoginText, userRows } from "./rows";

const entry = (id: string, groups: { id: string; name: string }[]): UserDirectoryEntry => ({
  id,
  uid: id,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "",
  sn: "",
  displayName: id,
  mail: null,
  avatarHash: null,
  role: "member",
  status: "active",
  lastLogin: null,
  accountExpires: null,
  passkey: false,
  groups,
  groupCount: groups.length,
});
const sales = { id: "g-sales", name: "Verkauf" };
const office = { id: "g-office", name: "Büro" };

test("grouped, an account stands in each of its groups, groups by name, accounts without a group last", () => {
  const page = [entry("ada", [sales]), entry("milan", [office, sales]), entry("vera", [])];
  expect(userRows(page, true, "de").map((row) => row.key)).toEqual(["g-office:milan", "g-sales:ada", "g-sales:milan", "none:vera"]);
  expect(inSeveralGroups(page)).toBe(1);
  expect(userRows(page, false, "de").map((row) => row.key)).toEqual(["ada", "milan", "vera"]);
});

test("the last sign-in reads as days within a month, then as the day", () => {
  const { t } = listMessages.resolve(["de"]);
  const context = { locale: "de", timeZone: "Europe/Berlin", now: new Date("2026-11-25T12:00:00Z") };
  expect(lastLoginText(null, t, context)).toBe("noch nie");
  expect(lastLoginText("2026-11-25T08:00:00Z", t, context)).toBe("heute");
  expect(lastLoginText("2026-11-20T08:00:00Z", t, context)).toBe("vor 5 Tagen");
  expect(lastLoginText("2026-10-14T08:00:00Z", t, context)).toBe("14.10.2026");
});
