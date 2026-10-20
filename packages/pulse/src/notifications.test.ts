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
