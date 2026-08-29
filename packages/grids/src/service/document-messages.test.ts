import { describe, expect, test } from "bun:test";
import { renderLiquidText, templatePatternContext } from "./document-liquid";
import { documentServiceMessages } from "./document-messages";

describe("document service messages", () => {
  test("keeps the English and German catalogs complete", () => {
    const english = documentServiceMessages.resolve(["en"]).t;
    const german = documentServiceMessages.resolve(["de"]).t;
    expect(Object.keys(german).sort()).toEqual(Object.keys(english).sort());
  });

  test("falls back from de-CH to German without losing regional locale input", () => {
    const { locale, t } = documentServiceMessages.resolve(["de-CH"]);
    expect(locale).toBe("de");
    expect(t.templateDisabled).toBe("Die Dokumentvorlage ist deaktiviert.");
    expect(t.fileLimit({ limit: 2 })).toBe("Das Dateifeld enthält bereits die Höchstzahl von 2 Dateien.");
  });

  test("localizes Liquid failures and visible draft data without global state", async () => {
    const germanFailure = await renderLiquidText(`{{ value | barcode_data_url: "Code 128" }}`, { value: "ITEM-1" }, undefined, "de-CH");
    expect(germanFailure.ok).toBe(false);
    if (!germanFailure.ok) expect(germanFailure.error.message).toBe("Die Vorlage konnte nicht gerendert werden.");
    expect(templatePatternContext(null, "de-CH").name).toBe("Vorlagenentwurf");
    expect(templatePatternContext(null, "en").name).toBe("Draft template");
  });
});
