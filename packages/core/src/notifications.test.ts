import { describe, expect, test } from "bun:test";
import { app } from "./config";

describe("Core notification definitions", () => {
  test("device enrollment is user-bound, required, and localized without credentials", async () => {
    const notice = app.notifications.deviceEnrollment;
    expect(notice.id).toBe("core.deviceEnrollment");
    expect(notice.recipient).toBe("user");
    expect(notice.delivery?.required).toEqual(["email"]);
    const de = await notice.render({ name: "Phone", assisted: true }, { locale: "de" });
    const en = await notice.render({ name: "Phone", assisted: false }, { locale: "en" });
    expect(de.body).toContain("Administrator");
    expect(en.title).toBe("New sign-in device linked");
    expect(de.targetHref).toBe("/me/security");
  });
  test("keeps account expiry reminders required and user-bound", () => {
    const reminder = app.notifications.accountExpiryReminder;

    expect(reminder.id).toBe("core.accountExpiryReminder");
    expect(reminder.recipient).toBe("user");
    expect(reminder.delivery?.required).toEqual(["email"]);
  });
});
