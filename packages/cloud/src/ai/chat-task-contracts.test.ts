import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import { coreSettings } from "@k2b/cloud/services";
import { chatTaskCreateFingerprint, normalizeChatTaskSchedule } from "./chat-task-contracts";

beforeEach(() => setSystemTime(new Date("2026-04-07T09:00:00.000Z")));
afterEach(() => {
  mock.restore();
  setSystemTime();
});

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

  test("binds the exact reviewed capability grant scope into create idempotency", () => {
    const input = {
      chatId: "cHt234",
      prompt: "Summarize mail",
      schedule: { kind: "cron" as const, cron: "0 9 * * *" },
      grants: [{ appId: "notebooks", capabilityId: "note.edit", kind: "action" as const, fixedInput: { noteId: "note-a" } }],
    };
    expect(chatTaskCreateFingerprint(input)).not.toBe(
      chatTaskCreateFingerprint({ ...input, grants: [{ ...input.grants[0]!, fixedInput: { noteId: "note-b" } }] }),
    );
    expect(chatTaskCreateFingerprint(input)).not.toBe(
      chatTaskCreateFingerprint({ ...input, grants: [{ ...input.grants[0]!, fixedInput: {} }] }),
    );
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

test("routine name uses title, chat title, then a bounded prompt line", async () => {
  const { chatTaskName } = await import("./chat-task-contracts");
  expect(chatTaskName({ title: "Neue Rechnungen", chatTitle: "Buchhaltung", prompt: "Check" })).toBe("Neue Rechnungen");
  expect(chatTaskName({ title: null, chatTitle: "Buchhaltung", prompt: "Check" })).toBe("Buchhaltung");
  expect(chatTaskName({ chatTitle: " ", prompt: "Check mail\nThen save" })).toBe("Check mail");
  expect(chatTaskName({ prompt: "x".repeat(100) })).toHaveLength(80);
  const input = { chatId: "abc234", prompt: "Check", schedule: { kind: "cron" as const, cron: "0 9 * * *" } };
  expect(chatTaskCreateFingerprint({ ...input, title: "First" })).not.toBe(chatTaskCreateFingerprint({ ...input, title: "Second" }));
});
