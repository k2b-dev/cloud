import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { CodeSchema } from "./contracts";
import { databaseDeletionDate, readUnusedDatabaseDays, unusedDatabaseInput } from "./database-retention";
import { CODE_SETTINGS, codeSettings } from "./settings";

afterEach(() => setSystemTime());
test("unused database deadline is thirty exact days and zero disables it", () => {
  setSystemTime(new Date("2026-11-01T12:00:00.000Z"));
  expect(databaseDeletionDate(new Date(), CODE_SETTINGS["core.code.database_unused_days"].default)?.toISOString()).toBe(
    "2026-12-01T12:00:00.000Z",
  );
  expect(databaseDeletionDate(new Date(), 0)).toBeNull();
  expect(databaseDeletionDate(new Date("2028-02-01T12:00:00.000Z"), 30)?.toISOString()).toBe("2028-03-02T12:00:00.000Z");
});
test("confirmed deletion binds both the incarnation and the unused period", () => {
  const input = { codeId: "c_test", namespace: "code_c_test_incarnation", since: "2026-11-01T12:00:00.000Z" };
  expect(unusedDatabaseInput.parse(input)).toEqual(input);
  expect(unusedDatabaseInput.safeParse({ codeId: input.codeId }).success).toBe(false);
  expect(unusedDatabaseInput.safeParse({ ...input, since: "yesterday" }).success).toBe(false);
});
test("the public database read preserves the deadline and delete permission", () => {
  const database = CodeSchema.shape.database.unwrap().parse({
    bytes: 4096,
    limit: 104857600,
    state: "ready",
    canExport: true,
    unused: {
      since: "2026-11-01T12:00:00.000Z",
      deleteAt: "2026-12-01T12:00:00.000Z",
      namespace: "code_c_test_incarnation",
      canDelete: true,
    },
  });
  expect(database.unused?.deleteAt).toBe("2026-12-01T12:00:00.000Z");
});

test("an unreadable retention setting stops destructive maintenance", async () => {
  const setting = spyOn(codeSettings, "read").mockResolvedValue({ value: 30, stored: "unreadable" });
  try {
    await expect(readUnusedDatabaseDays()).rejects.toThrow("code_database_retention_setting_unreadable");
  } finally {
    setting.mockRestore();
  }
});

test("shortening retention preserves the reminder period from the newly visible date", () => {
  setSystemTime(new Date("2026-12-01T12:00:00.000Z"));
  expect(databaseDeletionDate(new Date("2026-11-01T12:00:00.000Z"), 3, new Date())?.toISOString()).toBe("2026-12-08T12:00:00.000Z");
});
test("re-enabling retention starts a visible reminder period even when already overdue", () => {
  setSystemTime(new Date("2026-12-01T12:00:00.000Z"));
  const since = new Date("2026-10-01T12:00:00.000Z");
  expect(databaseDeletionDate(since, 0, new Date())).toBeNull();
  expect(databaseDeletionDate(since, 30, new Date())?.toISOString()).toBe("2026-12-08T12:00:00.000Z");
});
test("a newly visible date never shortens the ordinary unused period", () => {
  setSystemTime(new Date("2026-11-02T12:00:00.000Z"));
  expect(databaseDeletionDate(new Date("2026-11-01T12:00:00.000Z"), 30, new Date())?.toISOString()).toBe("2026-12-01T12:00:00.000Z");
});
