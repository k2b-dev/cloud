import { describe, expect, test } from "bun:test";
import type { sql } from "bun";
import {
  requirePublicId,
  resolveActiveMailboxId,
  resolveMailboxPublicId,
  resolvePublicId,
  resolvePublicIds,
  resolveReminderNotificationSourceId,
} from "./public-resources";

const unavailableDb = (() => {
  throw new Error("Invalid public IDs must not reach the database");
}) as unknown as typeof sql;

describe("Mail public resource boundary", () => {
  test("rejects UUID and malformed selectors before database resolution", async () => {
    const uuid = crypto.randomUUID();
    expect(await resolvePublicId("mailboxes", uuid, unavailableDb)).toBeNull();
    expect(await resolveActiveMailboxId(uuid, unavailableDb)).toBeNull();
    expect(await resolvePublicId("messages", "abc12", unavailableDb)).toBeNull();
    expect(await resolvePublicIds("drafts", ["abc123", uuid], unavailableDb)).toBeNull();
    expect(await resolveMailboxPublicId("conversations", uuid, "abc-12", unavailableDb)).toBeNull();
    expect(await resolveReminderNotificationSourceId(uuid, uuid, unavailableDb)).toBeNull();
  });

  test("keeps empty batch resolution database-free", async () => {
    expect(await resolvePublicIds("attachments", [], unavailableDb)).toEqual([]);
  });

  test("browser mailbox resolution excludes deleted rows without changing lifecycle resolution", async () => {
    const id = crypto.randomUUID();
    const queries: string[] = [];
    const db = ((parts: TemplateStringsArray) => {
      const query = parts.join("?");
      queries.push(query);
      return Promise.resolve(query.includes("deleted_at IS NULL") ? [] : [{ id, short_id: "Box001" }]);
    }) as unknown as typeof sql;

    expect(await resolvePublicId("mailboxes", "Box001", db)).toBe(id);
    expect(await resolveActiveMailboxId("Box001", db)).toBeNull();
    expect(queries).toHaveLength(2);
    expect(queries[1]).toContain("deleted_at IS NULL");
  });

  test("fails closed when an internal resource has no public ID", () => {
    expect(() => requirePublicId(new Map(), crypto.randomUUID())).toThrow("Missing public ID for Mail resource");
  });
});
