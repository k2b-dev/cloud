import { expect, test } from "bun:test";
import type { AccountDirectoryEntry, AccountDirectoryPerson } from "@k2b/cloud/contracts";
import { listMessages } from "../list-messages";
import { inSeveralGroups, lastLoginText, sharedAddresses, userRows } from "./rows";

const entry = (id: string, groups: { id: string; name: string }[], mail: string | null = null): AccountDirectoryPerson => ({
  kind: "person",
  id,
  uid: id,
  roles: ["user"],
  provider: "local",
  profile: "user",
  givenname: "",
  sn: "",
  displayName: id,
  mail,
  avatarHash: null,
  role: "member",
  status: "active",
  lastLogin: null,
  accountExpires: null,
  passkey: false,
  groups,
  groupCount: groups.length,
  duplicateMail: false,
});
const agent: AccountDirectoryEntry = {
  kind: "agent",
  id: "bot",
  name: "Wochenbericht",
  status: "active",
  avatarHash: null,
  lastUsed: null,
  createdAt: "2026-09-22T09:14:00.000Z",
};
const sales = { id: "g-sales", name: "Verkauf" };
const office = { id: "g-office", name: "Büro" };

test("grouped by group, a person stands in each of their groups, groups by name, accounts without a group last", () => {
  const page = [entry("ada", [sales]), entry("milan", [office, sales]), entry("vera", []), agent];
  expect(userRows(page, "member-of", "de").map((row) => row.key)).toEqual([
    "g-office:milan",
    "g-sales:ada",
    "g-sales:milan",
    "none:vera",
    "none:bot",
  ]);
  expect(inSeveralGroups(page)).toBe(1);
  expect(userRows(page, undefined, "de").map((row) => row.key)).toEqual(["ada", "milan", "vera", "bot"]);
});

test("grouped by address, accounts that share one stand together, compared trimmed and in any case", () => {
  const page = [
    entry("jonas", [], "j.hartwig@example.test"),
    entry("jhartwig", [], " J.Hartwig@example.test"),
    entry("lina", [], "lina@example.test"),
    agent,
  ];
  const rows = userRows(page, "mail", "de");
  expect(rows.map((row) => row.key)).toEqual([
    "j.hartwig@example.test:jonas",
    "j.hartwig@example.test:jhartwig",
    "lina@example.test:lina",
    "none:bot",
  ]);
  expect(sharedAddresses(page)).toBe(1);
});

test("the last sign-in reads as days within a month, then as the day", () => {
  const { t } = listMessages.resolve(["de"]);
  const context = { locale: "de", timeZone: "Europe/Berlin", now: new Date("2026-11-25T12:00:00Z") };
  expect(lastLoginText(null, t, context)).toBe("noch nie");
  expect(lastLoginText("2026-11-25T08:00:00Z", t, context)).toBe("heute");
  expect(lastLoginText("2026-11-20T08:00:00Z", t, context)).toBe("vor 5 Tagen");
  expect(lastLoginText("2026-10-14T08:00:00Z", t, context)).toBe("14.10.2026");
});
