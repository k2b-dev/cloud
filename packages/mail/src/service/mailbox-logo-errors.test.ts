import { describe, expect, test } from "bun:test";
import { err } from "@k2b/stdlib";
import { localizeMailError } from "./error-messages";
import { mailboxLogoFailure, mailboxLogoMessages } from "./mailbox-logo-errors";

describe("mailbox logo validation messages", () => {
  test("has complete English and German catalogs", () => {
    expect(mailboxLogoMessages.check()).toEqual([]);
  });

  test.each([
    ["tooLarge", "The logo may contain at most 100 KiB (102400 bytes)", "Das Logo darf höchstens 100 KiB (102400 Bytes) groß sein."],
    [
      "tooManyPixels",
      "The logo is 2000x500 pixels; the maximum is 1200x400 pixels",
      "Das Logo hat 2000×500 Pixel; erlaubt sind höchstens 1200×400 Pixel.",
    ],
    ["damaged", "The logo file is damaged or truncated", "Die Logodatei ist beschädigt oder unvollständig. Lade eine intakte Datei hoch."],
    [
      "rotated",
      "The logo is marked as rotated (EXIF orientation); rotate the image in an editor, save it upright, and upload it again",
      "Das Logo ist als gedreht markiert (EXIF-Ausrichtung). Drehe es in einem Bildeditor, speichere es aufrecht und lade es erneut hoch.",
    ],
    [
      "unsupportedType",
      "Unsupported logo type; upload a PNG or JPEG file",
      "Dieses Bildformat wird nicht unterstützt. Lade ein PNG oder JPEG hoch.",
    ],
    [
      "invalidAltText",
      "The logo alt text must have 1 to 200 characters without control characters",
      "Gib für den Alternativtext des Logos 1 bis 200 Zeichen ohne Steuerzeichen ein.",
    ],
  ] as const)("localizes %s without changing the English message, code, status or detail", (reason, english, german) => {
    const failure = mailboxLogoFailure(reason, reason === "tooManyPixels" ? { width: 2000, height: 500 } : undefined);
    expect(failure.message).toBe(english);
    expect(failure.mailboxLogo).toEqual(reason === "tooManyPixels" ? { reason, width: 2000, height: 500 } : { reason });
    for (const locale of ["en", "en-GB", "fr", undefined]) {
      expect(localizeMailError(failure, locale)).toEqual(failure);
    }
    for (const locale of ["de", "de-CH"]) {
      expect(localizeMailError(failure, locale)).toEqual({ ...failure, message: german });
    }
  });

  test("leaves unrelated or malformed error details to the generic localizer", () => {
    for (const mailboxLogo of [null, "tooLarge", {}, { reason: "unknown" }]) {
      const error = { ...err.badInput("Other input"), mailboxLogo };
      expect(localizeMailError(error, "en")).toEqual(error);
      expect(localizeMailError(error, "de").message).toBe("Die Eingabe ist ungültig: Other input");
    }
  });
});
