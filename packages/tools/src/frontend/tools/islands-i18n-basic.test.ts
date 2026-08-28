import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfig } from "@k2b/ssr";

const root = mkdtempSync(join(tmpdir(), "tools-islands-i18n-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { uuidMessages } = await import("./UuidGenerator.island.tsx");
const { hashMessages } = await import("./HashGenerator.island.tsx");
const { loremMessages } = await import("./LoremIpsumGenerator.island.tsx");
const { colorMessages } = await import("./ColorConverter.island.tsx");
const { encodingMessages } = await import("./EncodingTool.island.tsx");
const { mailtoMessages } = await import("./MailtoGenerator.island.tsx");

const catalogs = {
  uuid: uuidMessages,
  hash: hashMessages,
  lorem: loremMessages,
  color: colorMessages,
  encoding: encodingMessages,
  mailto: mailtoMessages,
} as const;

describe("tool island catalogs", () => {
  test.each(Object.entries(catalogs))("%s has a complete German catalog", (_name, catalog) => {
    expect(catalog.check()).toEqual([]);
  });

  test("German messages resolve for every island", () => {
    expect(uuidMessages.resolve(["de"]).t.copyAll).toBe("Alle kopieren");
    expect(hashMessages.resolve(["de"]).t.inputLabel).toBe("Eingabe");
    expect(loremMessages.resolve(["de"]).t.countDescriptionParagraphs).toBe("Absätze pro Durchlauf");
    expect(colorMessages.resolve(["de"]).t.invalidHex).toBe("Gib einen gültigen HEX-Wert an.");
    expect(encodingMessages.resolve(["de"]).t.formatInputLabel({ format: "Base64" })).toBe("Base64-Eingabe");
    expect(mailtoMessages.resolve(["de"]).t.emailLinkLabel({ to: "maria@example.com" })).toBe("E-Mail an maria@example.com");
  });

  test("English base stays intact", () => {
    expect(uuidMessages.resolve(["en"]).t.uuidCount({ count: 3 })).toBe("3 UUIDs");
    expect(encodingMessages.resolve(["en"]).t.formatOutputLabel({ format: "Base32" })).toBe("Base32 Output");
  });

  test("de-CH falls back to de", () => {
    const { locale, t } = uuidMessages.resolve(["de-CH"]);
    expect(locale).toBe("de");
    expect(t.count).toBe("Anzahl");
  });
});
