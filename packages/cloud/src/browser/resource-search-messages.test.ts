import { describe, expect, test } from "bun:test";
import { resourceSearchMessages } from "./resource-search-messages";

describe("resourceSearchMessages", () => {
  test("keeps both catalogs structurally complete", () => {
    expect(resourceSearchMessages.check()).toEqual([]);
  });

  test("uses German for regional German locales", () => {
    const { t } = resourceSearchMessages.resolve(["de-CH"]);

    expect(t.searchPlaceholder).toBe("Apps durchsuchen…");
    expect(t.resultCount({ count: 2 })).toBe("2 Ergebnisse");
  });

  test("falls back to English for unsupported locales", () => {
    expect(resourceSearchMessages.resolve(["fr-FR"]).t.allApps).toBe("All apps");
  });
});
