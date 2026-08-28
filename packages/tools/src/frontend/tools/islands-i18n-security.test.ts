import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";

const root = mkdtempSync(join(tmpdir(), "tools-islands-i18n-security-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { passwordMessages } = await import("./PasswordGenerator.island.tsx");
const { encryptionMessages } = await import("./EncryptionTool.island.tsx");
const { qrMessages } = await import("./qr-messages");

const catalogs = [
  ["password generator", passwordMessages],
  ["encryption tool", encryptionMessages],
  ["QR code generator", qrMessages],
] as const;

describe("security tool island catalogs", () => {
  test("German is complete for every catalog", () => {
    for (const [name, catalog] of catalogs) {
      expect(catalog.locales, name).toContain("de");
      expect(catalog.check(), name).toEqual([]);
    }
  });

  test("resolves German messages per island", () => {
    expect(passwordMessages.resolve(["de"]).t.copyPassword).toBe("Passwort kopieren");
    expect(encryptionMessages.resolve(["de"]).t.errDecryptFailedWrongKey).toBe(
      "Entschlüsselung fehlgeschlagen. Prüfe Schlüssel und Eingabe.",
    );
    expect(qrMessages.resolve(["de"]).t.previewEmpty).toBe("Inhalt hinzufügen, um einen QR-Code zu erstellen");
  });

  test("falls back from de-CH to de", () => {
    for (const [name, catalog] of catalogs) {
      expect(catalog.resolve(["de-CH"]).locale, name).toBe("de");
    }
    expect(qrMessages.resolve(["de-CH"]).t.previewHeading).toBe("Vorschau");
  });

  test("defaults to the English base locale", () => {
    for (const [name, catalog] of catalogs) {
      expect(catalog.resolve(["fr"]).locale, name).toBe("en");
    }
  });
});
