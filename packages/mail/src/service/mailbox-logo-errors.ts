import { err, i18n, type ServiceError } from "@k2b/stdlib";

/** Human messages for mailbox logo uploads that fail validation. */
export const mailboxLogoMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      tooLarge: "The logo may contain at most 100 KiB (102400 bytes)",
      tooManyPixels: ({ width, height }: { width: number; height: number }) =>
        `The logo is ${width}x${height} pixels; the maximum is 1200x400 pixels`,
      damaged: "The logo file is damaged or truncated",
      rotated: "The logo is marked as rotated (EXIF orientation); rotate the image in an editor, save it upright, and upload it again",
      unsupportedType: "Unsupported logo type; upload a PNG or JPEG file",
      invalidAltText: "The logo alt text must have 1 to 200 characters without control characters",
    },
    de: {
      tooLarge: "Das Logo darf höchstens 100 KiB (102400 Bytes) groß sein.",
      tooManyPixels: ({ width, height }) => `Das Logo hat ${width}×${height} Pixel; erlaubt sind höchstens 1200×400 Pixel.`,
      damaged: "Die Logodatei ist beschädigt oder unvollständig. Lade eine intakte Datei hoch.",
      rotated:
        "Das Logo ist als gedreht markiert (EXIF-Ausrichtung). Drehe es in einem Bildeditor, speichere es aufrecht und lade es erneut hoch.",
      unsupportedType: "Dieses Bildformat wird nicht unterstützt. Lade ein PNG oder JPEG hoch.",
      invalidAltText: "Gib für den Alternativtext des Logos 1 bis 200 Zeichen ohne Steuerzeichen ein.",
    },
  },
});

type MailboxLogoMessages = ReturnType<typeof mailboxLogoMessages.resolve>["t"];
export type MailboxLogoReason = keyof MailboxLogoMessages;
type PixelSize = { width: number; height: number };
type MailboxLogoFailure = ServiceError & { mailboxLogo: { reason: MailboxLogoReason } & Partial<PixelSize> };

const message = (t: MailboxLogoMessages, reason: MailboxLogoReason, size: PixelSize): string => {
  const entry = t[reason];
  return typeof entry === "function" ? entry(size) : entry;
};

/** A logo validation failure whose message Mail can show in every supported locale. */
export const mailboxLogoFailure = (reason: MailboxLogoReason, size?: PixelSize): MailboxLogoFailure =>
  Object.assign(err.badInput(message(mailboxLogoMessages.resolve(["en"]).t, reason, size ?? { width: 0, height: 0 })), {
    mailboxLogo: { reason, ...size },
  });

const isReason = (value: unknown): value is MailboxLogoReason =>
  typeof value === "string" && Object.hasOwn(mailboxLogoMessages.resolve(["en"]).t, value);

/** The localized message of a logo validation failure, or null for any other error. */
export const localizedMailboxLogoMessage = (error: object, locale: string): string | null => {
  const detail = "mailboxLogo" in error ? error.mailboxLogo : null;
  if (!detail || typeof detail !== "object" || !("reason" in detail) || !isReason(detail.reason)) return null;
  const width = "width" in detail && typeof detail.width === "number" ? detail.width : 0;
  const height = "height" in detail && typeof detail.height === "number" ? detail.height : 0;
  return message(mailboxLogoMessages.resolve([locale]).t, detail.reason, { width, height });
};
