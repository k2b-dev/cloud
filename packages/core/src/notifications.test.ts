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

test("AI cost notifications format reference amounts in the recipient locale", async () => {
  const notice = app.notifications.backgroundCosts;
  const data = { kind: "warning" as const, cost: 1234.567891, unit: "Credits" };
  for (const [locale, amount] of [
    ["de", "1.234,567891"],
    ["en", "1,234.567891"],
  ]) {
    expect((await notice.render(data, { locale: locale! })).body).toContain(`${amount} Credits`);
    expect((await notice.email!(data, { locale: locale! })).content).toContain(`${amount} Credits`);
  }
});
