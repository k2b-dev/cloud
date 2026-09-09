import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { coreSettings } from "@k2b/cloud/services";
import { chatTaskCreateFingerprint, normalizeChatTaskSchedule } from "./chat-task-contracts";

afterEach(() => mock.restore());

describe("scheduled chat task contracts", () => {
  test("resolves one-time local input with app.timezone", async () => {
    spyOn(coreSettings, "get").mockResolvedValue("Europe/Berlin");

    expect(await normalizeChatTaskSchedule({ kind: "once", localAt: "2099-06-15T09:30" })).toEqual({
      schedule: { kind: "once", runAt: "2099-06-15T07:30:00.000Z" },
      timezone: "Europe/Berlin",
    });
  });

  test("rejects nonexistent local wall-clock times", async () => {
    spyOn(coreSettings, "get").mockResolvedValue("Europe/Berlin");

    await expect(normalizeChatTaskSchedule({ kind: "once", localAt: "2099-03-29T02:30" })).rejects.toThrow();
  });

  test("normalizes recurring schedules in app.timezone", async () => {
    spyOn(coreSettings, "get").mockResolvedValue("Europe/Berlin");

    expect(await normalizeChatTaskSchedule({ kind: "cron", cron: "0 9 * * 1" })).toEqual({
      schedule: { kind: "cron", cron: "0 9 * * 1" },
      timezone: "Europe/Berlin",
    });
  });

  test("binds reviewed capability schedules to an explicit timezone", async () => {
    spyOn(coreSettings, "get").mockResolvedValue("UTC");

    expect(await normalizeChatTaskSchedule({ kind: "once", localAt: "2099-06-15T09:30" }, "Europe/Berlin")).toEqual({
      schedule: { kind: "once", runAt: "2099-06-15T07:30:00.000Z" },
      timezone: "Europe/Berlin",
    });
  });

  test("includes the reviewed timezone in create idempotency", () => {
    const input = {
      chatId: "cHt234",
      prompt: "Check release.",
      schedule: { kind: "once" as const, localAt: "2099-06-15T09:30" },
      timezone: "Europe/Berlin",
    };

    expect(chatTaskCreateFingerprint(input)).not.toBe(chatTaskCreateFingerprint({ ...input, timezone: "UTC" }));
  });
});
