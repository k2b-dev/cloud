import { describe, expect, test } from "bun:test";
import { imageConverterMessages } from "./image-converter/messages";
import { imageIntakeMessages } from "./image-intake/messages";
import { photoEditorMessages } from "./image-processor/photo-editor-messages";

describe("image tools i18n", () => {
  test("all image catalogs ship a complete German locale", () => {
    expect(imageConverterMessages.check()).toEqual([]);
    expect(photoEditorMessages.check()).toEqual([]);
    expect(imageIntakeMessages.check()).toEqual([]);
  });

  test("resolves German converter messages including plural pairs", () => {
    const { t } = imageConverterMessages.resolve(["de"]);
    expect(t.heading).toBe("Bilder");
    expect(t.imagesSkipped({ count: 1 })).toBe("Ein Bild wurde übersprungen.");
    expect(t.imagesSkipped({ count: 3 })).toBe("3 Bilder wurden übersprungen.");
    expect(t.downloadedImages({ count: 1 })).toBe("1 konvertiertes Bild heruntergeladen");
    expect(t.downloadedImages({ count: 4 })).toBe("4 konvertierte Bilder heruntergeladen");
    expect(t.selectImage({ name: "team-photo.png" })).toBe("team-photo.png auswählen");
    expect(t.clearConfirm({ count: 2 })).toBe("Alle 2 Dateien aus dem Konverter entfernen?");
  });

  test("resolves German photo editor save and recovery labels", () => {
    const { t } = photoEditorMessages.resolve(["de"]);
    expect(t.open).toBe("Fotos zum Bearbeiten wählen");
    expect(t.downloadAll).toBe("Alle als ZIP herunterladen");
    expect(t.exportFailed).toContain("Deine Änderungen bleiben erhalten");
  });

  test("falls back from de-CH to de and defaults to English", () => {
    expect(imageConverterMessages.resolve(["de-CH"]).t.heading).toBe("Bilder");
    expect(photoEditorMessages.resolve(["de-CH"]).t.photo).toBe("Foto");
    expect(imageConverterMessages.resolve(["fr"]).t.heading).toBe("Images");
  });
});
