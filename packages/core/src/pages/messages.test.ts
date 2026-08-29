import { describe, expect, test } from "bun:test";
import { corePageMessages } from "./messages";
import { adminMessages } from "./admin/messages";
import { settingsMessages } from "./admin/settings/_components/messages";
import { aiSettingsMessages } from "./admin/settings/_components/ai-settings-messages";
import { aiUsageMessages } from "./admin/settings/_components/ai-usage-messages";
import { authMessages } from "./auth/messages";

describe("corePageMessages", () => {
  test("keeps all Core catalogs structurally complete", () => {
    expect(corePageMessages.check()).toEqual([]);
    expect(authMessages.check()).toEqual([]);
    expect(adminMessages.check()).toEqual([]);
    expect(settingsMessages.check()).toEqual([]);
    expect(aiSettingsMessages.check()).toEqual([]);
    expect(aiUsageMessages.check()).toEqual([]);
  });

  test("uses German for regional German locales", () => {
    const { t } = corePageMessages.resolve(["de-CH"]);

    expect(t.pageNotFound).toBe("Seite nicht gefunden");
    expect(t.helpTitle({ appName: "Cloud" })).toBe("Cloud-Hilfe");
  });

  test("falls back to English for unsupported locales", () => {
    expect(corePageMessages.resolve(["fr-FR"]).t.pageNotFound).toBe("Page not found");
  });
});
