import { describe, expect, test } from "bun:test";
import { imageConverterMessages } from "./image-converter/messages";
import { imageProcessorMessages } from "./image-processor/messages";

describe("image tools i18n", () => {
  test("both catalogs ship a complete German locale", () => {
    expect(imageConverterMessages.check()).toEqual([]);
    expect(imageProcessorMessages.check()).toEqual([]);
  });

  test("resolves German converter messages including plural pairs", () => {
    const { t } = imageConverterMessages.resolve(["de"]);
    expect(t.heading).toBe("Bilder");
    expect(t.imagesSkipped({ count: 1 })).toBe("Ein Bild wurde übersprungen.");
    expect(t.imagesSkipped({ count: 3 })).toBe("3 Bilder wurden übersprungen.");
    expect(t.downloadedImages({ count: 1 })).toBe("1 konvertiertes Bild heruntergeladen");
    expect(t.downloadedImages({ count: 4 })).toBe("4 konvertierte Bilder heruntergeladen");
    expect(t.selectImage({ name: "team-photo.png" })).toBe("team-photo.png auswählen");
    expect(t.clearConfirm({ count: 2 })).toBe("Alle 2 Bilder aus dem Konverter entfernen?");
  });

  test("resolves German processor messages including aria labels", () => {
    const { t } = imageProcessorMessages.resolve(["de"]);
    expect(t.resizeFromTopLeft).toBe("Größe von oben links ändern");
    expect(t.markupCanvas).toBe("Zeichenfläche für Markierungen");
    expect(t.useColor({ color: t.colorRed })).toBe("Rot verwenden");
    expect(t.exportStopped({ completed: 2, count: 5 })).toBe("Export nach 2 von 5 Bildern gestoppt.");
    expect(t.subtitleDimensionsSize({ width: 1200, height: 800, kb: "42" })).toBe("1200 × 800 px · 42 KB");
  });

  test("falls back from de-CH to de and defaults to English", () => {
    expect(imageConverterMessages.resolve(["de-CH"]).t.heading).toBe("Bilder");
    expect(imageProcessorMessages.resolve(["de-CH"]).t.noImageSelected).toBe("Kein Bild ausgewählt");
    expect(imageConverterMessages.resolve(["fr"]).t.heading).toBe("Images");
  });
});
