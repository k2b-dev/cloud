type HumanFacingError = { code: string; message: string; status: number };

const genericGermanMessage = (error: HumanFacingError): string => {
  if (error.code === "BAD_INPUT") return "Die Eingabe ist ungültig";
  if (error.code === "NOT_FOUND") return "Die angeforderte Mail-Ressource wurde nicht gefunden";
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
  return { ...error, message: genericGermanMessage(error) };
};
