import { expect, test } from "bun:test";
import { app } from "./config";

test("Pulse notifications use the delivery locale and preference-aware user delivery", async () => {
  const storage = app.notifications.storageThresholdReached;
  const data = { baseName: "Operations", threshold: 1000 };
  const en = await storage.render(data, { locale: "en" });
  const de = await storage.render(data, { locale: "de-CH" });
  expect(en.title).toBe("Storage threshold reached");
  expect(de.title).toBe("Speichergrenze erreicht");
  expect(en.body).toContain("Operations");
  expect(de.body).toContain("1000");
  expect(await app.notifications.storeDiskLow.render({ freePercent: 9 }, { locale: "de" })).toMatchObject({
    body: expect.stringContaining("9.0 %"),
  });
  expect(await app.notifications.storeUnavailable.render({}, { locale: "de" })).toMatchObject({ title: "Datenspeicher nicht erreichbar" });
  expect(storage.recipient).toBe("user");
  expect(storage.delivery).toEqual({ recommended: ["browser", "email"], required: [] });
});

test("alarm and freshness browser/email text share delivery metadata without locale in their payload", async () => {
  const alert = app.notifications.alert;
  const data = {
    baseId: "Base01",
    baseName: "Operations",
    ruleId: "Rule01",
    ruleName: "CPU",
    key: "host <one>",
    state: "firing" as const,
    severity: "critical" as const,
    value: 12.5,
    error: null,
  };
  for (const [locale, title, value] of [
    ["de", "Kritischer Alarm", "12,5"],
    ["en", "Critical alert", "12.5"],
  ]) {
    const rendered = await alert.render(data, { locale: locale! });
    const email = await alert.email!(data, { locale: locale! });
    expect(rendered.title).toBe(`CPU: ${title}`);
    expect(rendered.body).toContain(value!);
    expect(rendered.body).toContain("host <one>");
    expect(email).toMatchObject({ subject: rendered.title, content: rendered.body });
    const source = { baseId: "Base01", baseName: "Operations", sourceId: "Src001", sourceName: "Website", stale: true, newestDataAt: null };
    const notice = await app.notifications.sourceStale.render(source, { locale: locale! });
    expect(await app.notifications.sourceStale.email!(source, { locale: locale! })).toMatchObject({
      subject: notice.title,
      content: notice.body,
    });
    expect(notice.targetHref).toBe("/app/pulse/Base01/sources/Src001");
  }
  expect(alert.data.safeParse({ ...data, locale: "de" }).success).toBe(false);
  expect(alert.delivery).toEqual({ recommended: ["browser", "email"], required: [] });
});

test("long alert keys fit Cloud presentation limits without losing the value or splitting Unicode", async () => {
  for (const locale of ["de", "en"]) {
    const data = {
      baseId: "Base01",
      baseName: "Operations",
      ruleId: "Rule01",
      ruleName: "CPU",
      key: "😀".repeat(3000),
      state: "firing" as const,
      severity: "critical" as const,
      value: 12.5,
      error: null,
    };
    const rendered = await app.notifications.alert.render(data, { locale });
    expect(rendered.body!.length).toBeLessThanOrEqual(4000);
    expect(rendered.body!.isWellFormed()).toBe(true);
    expect(rendered.body).toEndWith(`… · ${locale === "de" ? "12,5" : "12.5"}`);
    expect(await app.notifications.alert.email!(data, { locale })).toMatchObject({ content: rendered.body });
    expect(data.key).toHaveLength(6000);
  }
});
