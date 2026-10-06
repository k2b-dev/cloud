import { describe, expect, test } from "bun:test";
import type { PermissionLevel, Principal, ServiceAccountKind } from "../contracts/shared";
import { ensureManagerRemains } from "../server/services/access";
import { isManagerEntry, removesLastManager } from "./managers";

const entry = (principal: Principal, permission: PermissionLevel = "admin", serviceAccountKind?: ServiceAccountKind) => ({
  principal,
  permission,
  serviceAccountKind,
});
const person = (userId: string, permission: PermissionLevel = "admin") => entry({ type: "user", userId }, permission);

describe("isManagerEntry", () => {
  test("counts Manage for people, groups, all signed-in users, and standalone or agent accounts", () => {
    expect(isManagerEntry(person("qdt"))).toBe(true);
    expect(isManagerEntry(entry({ type: "group", groupId: "staff" }))).toBe(true);
    expect(isManagerEntry(entry({ type: "authenticated" }))).toBe(true);
    for (const kind of ["standalone", "agent"] as const) {
      expect(isManagerEntry(entry({ type: "service_account", serviceAccountId: kind }, "admin", kind))).toBe(true);
    }
  });

  test("never counts public access, keys that vanish with their resource or user, or lower levels", () => {
    expect(isManagerEntry(entry({ type: "public" }))).toBe(false);
    for (const kind of ["resource_bound", "user_delegated", undefined] as const) {
      expect(isManagerEntry(entry({ type: "service_account", serviceAccountId: "key" }, "admin", kind))).toBe(false);
    }
    for (const level of ["none", "read", "write"] as const) expect(isManagerEntry(person("qdt", level))).toBe(false);
  });
});

describe("removesLastManager", () => {
  test("blocks only the step from at least one manager to none", () => {
    expect(removesLastManager([person("qdt")], [person("qdt", "write")])).toBe(true);
    expect(removesLastManager([person("qdt")], [])).toBe(true);
    expect(removesLastManager([person("qdt"), person("lym")], [person("lym")])).toBe(false);
    // A resource that already has no manager stays repairable.
    expect(removesLastManager([person("qdt", "read")], [])).toBe(false);
  });

  test("a resource-bound key does not stand in for the last person", () => {
    const key = entry({ type: "service_account", serviceAccountId: "key" }, "admin", "resource_bound");
    expect(removesLastManager([person("qdt"), key], [person("qdt", "read"), key])).toBe(true);
  });
});

describe("ensureManagerRemains", () => {
  test("fails with a stable code and a localized message", () => {
    for (const [locale, text] of [
      ["en", "The last entry with “Manage” access can't be lowered or removed."],
      ["de-DE", "Der letzte Eintrag mit Zugriff „Verwalten“ kann nicht herabgestuft oder entfernt werden."],
    ] as const) {
      const result = ensureManagerRemains({ before: [person("qdt")], after: [person("qdt", "write")], locale });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toMatchObject({ code: "LAST_MANAGER", status: 409 });
      expect(result.error.message).toStartWith(text);
    }
  });

  test("allows a change that keeps a manager", () => {
    expect(ensureManagerRemains({ before: [person("qdt"), person("lym")], after: [person("lym")] }).ok).toBe(true);
  });
});
