import { expect, test } from "bun:test";
import { NotificationUpdateSchema } from "./contracts";
import { type NotificationChoice, type NotificationContext, resolveNotifications } from "./notification-levels";

const now = new Date("2026-10-28T12:00:00.000Z");
const base: NotificationContext & { notify: NotificationChoice; notifyUntil: Date | null } = {
  kind: "chat",
  channel: false,
  permission: "write",
  memberCount: 20,
  notify: "default",
  notifyUntil: null,
};

test("defaults follow kind, channel role and the exact 20/21 boundary", () => {
  for (const [change, expected] of [
    [{}, "all"],
    [{ memberCount: 21 }, "mentions"],
    [{ kind: "system" }, "mentions"],
    [{ kind: "system", channel: true, permission: "read" }, "mentions"],
    [{ channel: true, permission: "read", memberCount: 21 }, "all"],
    [{ channel: true, permission: "write", memberCount: 21 }, "mentions"],
    [{ channel: true, permission: "admin", memberCount: 21 }, "mentions"],
  ] satisfies [Partial<typeof base>, "all" | "mentions"][])
    expect(resolveNotifications({ ...base, ...change }, now)).toEqual({
      level: expected,
      defaultLevel: expected,
      choice: null,
      until: null,
    });
});
test("explicit choices survive growth; expiry including equality resets to the current default", () => {
  for (const notify of ["all", "mentions", "none"] as const)
    expect(resolveNotifications({ ...base, memberCount: 500, notify }, now)).toMatchObject({
      level: notify,
      choice: notify,
      defaultLevel: "mentions",
    });
  for (const notifyUntil of [new Date("2026-10-28T11:59:59Z"), now])
    expect(resolveNotifications({ ...base, notify: "none", notifyUntil }, now)).toEqual({
      level: "all",
      defaultLevel: "all",
      choice: null,
      until: null,
    });
  const until = new Date("2026-10-28T13:00:00Z");
  expect(resolveNotifications({ ...base, notify: "none", notifyUntil: until }, now)).toMatchObject({
    level: "none",
    choice: "none",
    until: until.toISOString(),
  });
  expect(() => resolveNotifications({ ...base, notifyUntil: until }, now)).toThrow("notify_until");
});
test("only none accepts a duration and every body is strict", () => {
  for (const level of ["default", "all", "mentions"]) {
    expect(NotificationUpdateSchema.safeParse({ level }).success).toBeTrue();
    expect(NotificationUpdateSchema.safeParse({ level, for: "1h" }).success).toBeFalse();
  }
  for (const duration of ["1h", "8h", "1w", "forever"])
    expect(NotificationUpdateSchema.safeParse({ level: "none", for: duration }).success).toBeTrue();
  for (const input of [{ level: "none" }, { level: "none", for: "2h" }, { level: "all", until: now.toISOString() }, { level: "off" }])
    expect(NotificationUpdateSchema.safeParse(input).success).toBeFalse();
});
