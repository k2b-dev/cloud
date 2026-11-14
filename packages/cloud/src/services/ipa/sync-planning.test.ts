import { describe, expect, test } from "bun:test";
import { assessIpaDestructionGuard, createIpaIdentityMatcher, readCompleteIpaList, selectStaleLocalIpaRows } from "./sync-planning";

describe("createIpaIdentityMatcher", () => {
  const legacy = { id: "u1", uid: "eva", entryId: null };
  const bound = { id: "u2", uid: "max", entryId: "ipauniqueid:entry-max" };
  const match = createIpaIdentityMatcher([legacy, bound]);

  test("matches a stored entry ID under a new username", () => {
    expect(match({ uid: "max-renamed", entryId: "ipauniqueid:entry-max" })).toEqual({ kind: "matched", row: bound });
  });

  test("matches an account without a stored entry ID by username", () => {
    expect(match({ uid: "eva", entryId: "ipauniqueid:entry-eva" })).toEqual({ kind: "matched", row: legacy });
  });

  test("reports a username whose account stores another entry ID as a conflict", () => {
    expect(match({ uid: "max", entryId: "ipauniqueid:other" })).toEqual({ kind: "conflict", row: bound });
  });

  test("neither confirms nor replaces a stored entry ID when the directory returns none", () => {
    expect(match({ uid: "max", entryId: null })).toEqual({ kind: "unverified", row: bound });
  });

  test("never matches by anything but username and entry ID", () => {
    expect(match({ uid: "new-person", entryId: "ipauniqueid:new" })).toEqual({ kind: "none" });
  });
});

describe("selectStaleLocalIpaRows", () => {
  test("keeps unchanged active IPA users out of stale transitions", () => {
    const stale = selectStaleLocalIpaRows({
      localRows: [{ id: "u1", uid: "eva", entryId: "ipauniqueid:entry-eva" }],
      activeRemoteUsers: [{ uid: "eva", entryId: "ipauniqueid:entry-eva" }],
    });

    expect(stale).toEqual([]);
  });

  test("keeps renamed IPA users out of stale transitions by entry ID", () => {
    const stale = selectStaleLocalIpaRows({
      localRows: [{ id: "u1", uid: "old-eva", entryId: "ipauniqueid:entry-eva" }],
      activeRemoteUsers: [{ uid: "new-eva", entryId: "ipauniqueid:entry-eva" }],
    });

    expect(stale).toEqual([]);
  });

  test("returns an IPA user whose username now belongs to another directory entry as stale", () => {
    const local = { id: "u1", uid: "eva", entryId: "ipauniqueid:entry-eva" };
    const stale = selectStaleLocalIpaRows({
      localRows: [local],
      activeRemoteUsers: [{ uid: "eva", entryId: "ipauniqueid:entry-other" }],
    });

    expect(stale).toEqual([local]);
  });

  test("keeps an account whose directory record has no entry ID out of stale transitions", () => {
    const stale = selectStaleLocalIpaRows({
      localRows: [{ id: "u1", uid: "eva", entryId: "ipauniqueid:entry-eva" }],
      activeRemoteUsers: [{ uid: "eva", entryId: null }],
    });

    expect(stale).toEqual([]);
  });

  test("returns IPA users with no active identity match as stale", () => {
    const local = { id: "u1", uid: "old-eva", entryId: null };
    const stale = selectStaleLocalIpaRows({
      localRows: [local],
      activeRemoteUsers: [{ uid: "new-eva", entryId: "ipauniqueid:entry-new" }],
    });

    expect(stale).toEqual([local]);
  });
});

describe("assessIpaDestructionGuard", () => {
  const limits = {
    maxUserChanges: 10,
    maxUserChangePercent: 20,
    maxGroupDeletions: 5,
    maxGroupDeletionPercent: 20,
  };

  test("deduplicates users affected by both stale transition and profile demotion", () => {
    const report = assessIpaDestructionGuard({
      affectedUserIds: ["u1", "u1", "u2"],
      localUsers: 10,
      deletedGroupNames: [],
      localGroups: 10,
      limits,
    });

    expect(report.userChanges).toBe(2);
    expect(report.userChangePercent).toBe(20);
    expect(report.violations).toEqual([]);
  });

  test("allows exact absolute and percentage boundaries", () => {
    const report = assessIpaDestructionGuard({
      affectedUserIds: ["u1", "u2"],
      localUsers: 10,
      deletedGroupNames: ["g1"],
      localGroups: 5,
      limits: { ...limits, maxUserChanges: 2, maxGroupDeletions: 1 },
    });

    expect(report.violations).toEqual([]);
  });

  test("rejects when either absolute or percentage user limit is exceeded", () => {
    const countViolation = assessIpaDestructionGuard({
      affectedUserIds: ["u1", "u2"],
      localUsers: 100,
      deletedGroupNames: [],
      localGroups: 0,
      limits: { ...limits, maxUserChanges: 1, maxUserChangePercent: 100 },
    });
    const percentViolation = assessIpaDestructionGuard({
      affectedUserIds: ["u1", "u2"],
      localUsers: 5,
      deletedGroupNames: [],
      localGroups: 0,
      limits: { ...limits, maxUserChanges: 10, maxUserChangePercent: 20 },
    });

    expect(countViolation.violations).toContain("user_count");
    expect(countViolation.violations).not.toContain("user_percent");
    expect(percentViolation.violations).toContain("user_percent");
    expect(percentViolation.violations).not.toContain("user_count");
  });

  test("zero limits mean zero destructive changes", () => {
    const zeroPlan = assessIpaDestructionGuard({
      affectedUserIds: [],
      localUsers: 1,
      deletedGroupNames: [],
      localGroups: 1,
      limits: { maxUserChanges: 0, maxUserChangePercent: 0, maxGroupDeletions: 0, maxGroupDeletionPercent: 0 },
    });
    const destructivePlan = assessIpaDestructionGuard({
      affectedUserIds: ["u1"],
      localUsers: 1,
      deletedGroupNames: ["g1"],
      localGroups: 1,
      limits: { maxUserChanges: 0, maxUserChangePercent: 0, maxGroupDeletions: 0, maxGroupDeletionPercent: 0 },
    });

    expect(zeroPlan.violations).toEqual([]);
    expect(destructivePlan.violations).toEqual(["user_count", "user_percent", "group_count", "group_percent"]);
  });

  test("100 percent override still requires the absolute limit to be raised", () => {
    const report = assessIpaDestructionGuard({
      affectedUserIds: ["u1", "u2"],
      localUsers: 2,
      deletedGroupNames: ["g1", "g2"],
      localGroups: 2,
      limits: { maxUserChanges: 1, maxUserChangePercent: 100, maxGroupDeletions: 1, maxGroupDeletionPercent: 100 },
    });

    expect(report.violations).toEqual(["user_count", "group_count"]);
  });

  test("allows deliberate large-directory override after both limits are raised", () => {
    const report = assessIpaDestructionGuard({
      affectedUserIds: Array.from({ length: 50 }, (_, index) => `u${index}`),
      localUsers: 100,
      deletedGroupNames: Array.from({ length: 25 }, (_, index) => `g${index}`),
      localGroups: 50,
      limits: { maxUserChanges: 50, maxUserChangePercent: 50, maxGroupDeletions: 25, maxGroupDeletionPercent: 50 },
    });

    expect(report.violations).toEqual([]);
  });
});

describe("readCompleteIpaList", () => {
  test("returns complete arrays", () => {
    expect(
      readCompleteIpaList({
        response: { result: { result: [{ uid: ["eva"] }], truncated: false }, error: null },
        entity: "users",
      }),
    ).toEqual([{ uid: ["eva"] }]);
  });

  test("rejects truncated and invalid snapshots", () => {
    expect(() =>
      readCompleteIpaList({
        response: { result: { result: [], truncated: true }, error: null },
        entity: "groups",
      }),
    ).toThrow("truncated snapshot");
    expect(() =>
      readCompleteIpaList({
        response: { result: { result: null, truncated: false }, error: null },
        entity: "users",
      }),
    ).toThrow("invalid list payload");
    expect(() =>
      readCompleteIpaList({
        response: { result: { result: [] }, error: null },
        entity: "users",
      }),
    ).toThrow("invalid completeness metadata");
  });
});
