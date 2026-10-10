import { err, i18n, type ServiceError } from "@k2b/stdlib";

/** Human messages for drafts that cannot be rendered. Preview, send, schedule, capabilities, and the CLI show them. */
const composeRenderMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      mailboxStyle:
        "The email design of this mailbox is no longer valid. Someone with Manage access can fix it with Edit design in Settings → Writing.",
      tooLarge: "This message is too large to render safely. Shorten it and try again.",
      tooManyLines: ({ limit }: { limit: number }) =>
        `A Markdown message may have at most ${limit.toLocaleString("en")} lines. Shorten it and try again.`,
      tooComplex: "This message is too complex to render safely. Shorten it or simplify its formatting.",
      tooManySignatures: ({ limit }: { limit: number }) => `A message may contain at most ${limit} signatures. Remove some and try again.`,
      signatureFailed: "A signature in this message could not be filled in. Remove it, or check it in Settings → Writing.",
      conversionFailed: "This message could not be converted to email. Check its formatting and try again.",
    },
    de: {
      mailboxStyle:
        "Das E-Mail-Design dieses Postfachs ist nicht mehr gültig. Jemand mit Zugriff „Verwalten“ kann es unter Einstellungen → Schreiben mit „Design bearbeiten“ korrigieren.",
      tooLarge: "Diese Nachricht ist zu groß, um sie sicher darzustellen. Kürze sie und versuche es erneut.",
      tooManyLines: ({ limit }) =>
        `Eine Markdown-Nachricht darf höchstens ${limit.toLocaleString("de")} Zeilen haben. Kürze sie und versuche es erneut.`,
      tooComplex: "Diese Nachricht ist zu komplex, um sie sicher darzustellen. Kürze sie oder vereinfache die Formatierung.",
      tooManySignatures: ({ limit }) =>
        `Eine Nachricht darf höchstens ${limit} Signaturen enthalten. Entferne einige und versuche es erneut.`,
      signatureFailed:
        "Eine Signatur in dieser Nachricht konnte nicht ausgefüllt werden. Entferne sie oder prüfe sie unter Einstellungen → Schreiben.",
      conversionFailed: "Diese Nachricht konnte nicht in eine E-Mail umgewandelt werden. Prüfe die Formatierung und versuche es erneut.",
    },
  },
});

type ComposeRenderMessages = ReturnType<typeof composeRenderMessages.resolve>["t"];
export type ComposeRenderReason = keyof ComposeRenderMessages;
type ComposeRenderFailure = ServiceError & { composeRender: { reason: ComposeRenderReason; limit?: number } };

const message = (t: ComposeRenderMessages, reason: ComposeRenderReason, limit = 0): string => {
  const entry = t[reason];
  return typeof entry === "function" ? entry({ limit }) : entry;
};

/** A render failure whose message Mail can show in every supported locale. */
export const composeRenderFailure = (reason: ComposeRenderReason, limit?: number): ComposeRenderFailure =>
  Object.assign(err.badInput(message(composeRenderMessages.resolve(["en"]).t, reason, limit)), {
    composeRender: limit === undefined ? { reason } : { reason, limit },
  });

const isReason = (value: unknown): value is ComposeRenderReason =>
  typeof value === "string" && Object.hasOwn(composeRenderMessages.resolve(["en"]).t, value);

/** The localized message of a render failure, or null for any other error. */
export const localizedComposeRenderMessage = (error: object, locale: string): string | null => {
  const detail = "composeRender" in error ? error.composeRender : null;
  if (!detail || typeof detail !== "object" || !("reason" in detail) || !isReason(detail.reason)) return null;
  const limit = "limit" in detail && typeof detail.limit === "number" ? detail.limit : 0;
  return message(composeRenderMessages.resolve([locale]).t, detail.reason, limit);
};
