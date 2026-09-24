type HumanFacingError = { code: string; message: string; status: number };

/** Longest error detail shown to people after a generic message. */
export const MAX_ERROR_DETAIL_LENGTH = 300;

const REDACTED = "[redacted]";

/**
 * Makes an error detail safe to show: removes known secret values and credential-shaped text,
 * collapses whitespace, and bounds the length. Returns null when nothing useful remains.
 */
export const safeErrorDetail = (text: string, secrets: readonly string[] = []): string | null => {
  let detail = text;
  for (const secret of secrets) if (secret) detail = detail.split(secret).join(REDACTED);
  detail = detail
    .replace(/\b(AUTH(?:ENTICATE)?\s+(?:PLAIN|LOGIN|XOAUTH2|OAUTHBEARER)|Bearer)\s+\S+/gi, `$1 ${REDACTED}`)
    .replace(/\b(password|passwd|token|secret)\s*[=:]\s*\S+/gi, `$1=${REDACTED}`)
    .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, REDACTED)
    .replace(/\s+/g, " ")
    .trim();
  if (!detail) return null;
  return detail.length > MAX_ERROR_DETAIL_LENGTH ? `${detail.slice(0, MAX_ERROR_DETAIL_LENGTH - 1).trimEnd()}…` : detail;
};

const genericGermanMessage = (error: HumanFacingError): string => {
  if (error.code === "BAD_INPUT") {
    const detail = safeErrorDetail(error.message);
    return detail ? `Die Eingabe ist ungültig: ${detail}` : "Die Eingabe ist ungültig";
  }
  if (error.code === "NOT_FOUND") return "Die angeforderte Mail-Ressource wurde nicht gefunden";
  if (error.code === "PROVIDER_BUSY") return "Die Synchronisierung läuft gerade. Versuche es in einem Moment erneut.";
  if (error.code === "CONFLICT") return "Der aktuelle Stand hat sich geändert. Lade die Daten neu und versuche es erneut.";
  if (error.code === "FORBIDDEN") return "Du hast nicht die erforderliche Berechtigung";
  if (error.status === 429) return "Zu viele Anfragen. Versuche es gleich erneut.";
  if (error.status === 503) return "Mail ist vorübergehend nicht verfügbar. Versuche es gleich erneut.";
  return "Mail konnte die Anfrage nicht verarbeiten";
};

/** Localizes a final API or capability error while preserving its stable code and status. */
export const localizeMailError = <T extends HumanFacingError>(error: T, locale?: string | null): T => {
  const normalizedLocale = locale?.toLowerCase();
  if (normalizedLocale !== "de" && !normalizedLocale?.startsWith("de-")) return error;
  if (error.code === "NOT_FOUND" && error.message === "Mailbox not found")
    return { ...error, message: "Das Postfach wurde nicht gefunden" };
  return { ...error, message: genericGermanMessage(error) };
};
