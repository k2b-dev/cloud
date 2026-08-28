const germanMessages: Readonly<Record<string, string>> = {
  "Mailbox not found": "Das Postfach wurde nicht gefunden",
  "Conversation not found": "Die Unterhaltung wurde nicht gefunden",
  "Message not found": "Die E-Mail wurde nicht gefunden",
  "Mail message not found": "Die E-Mail wurde nicht gefunden",
  "Draft not found": "Der Entwurf wurde nicht gefunden",
  "Draft attachment not found": "Der Entwurfsanhang wurde nicht gefunden",
  "Attachment not found": "Der Anhang wurde nicht gefunden",
  "Mail folder not found": "Der E-Mail-Ordner wurde nicht gefunden",
  "Sender identity not found": "Die Absenderidentität wurde nicht gefunden",
  "Provider connection not found": "Die Anbieterverbindung wurde nicht gefunden",
  "Workflow not found": "Der Workflow wurde nicht gefunden",
  "Workflow version not found": "Die Workflow-Version wurde nicht gefunden",
  "Comment not found": "Der Kommentar wurde nicht gefunden",
  "Reminder not found": "Die Erinnerung wurde nicht gefunden",
  "Local tag not found": "Der lokale Tag wurde nicht gefunden",
  "Mail resource not found": "Die Mail-Ressource wurde nicht gefunden",
  "Access denied": "Zugriff verweigert",
  "Cloud administration access is required": "Cloud-Administrationsrechte sind erforderlich",
  "Browser OAuth requires an active user session": "Browser-OAuth erfordert eine aktive Benutzersitzung",
  "Invalid pagination cursor": "Der Seitencursor ist ungültig",
  "Invalid search cursor": "Der Suchcursor ist ungültig",
  "Invalid related Mail cursor": "Der Cursor für verwandte E-Mails ist ungültig",
  "Invalid subscription cursor": "Der Mailinglisten-Cursor ist ungültig",
  "Access permission cannot be none": "Die Berechtigung darf nicht „Kein Zugriff“ sein",
  "Use DELETE to revoke access": "Verwende DELETE, um den Zugriff zu entziehen",
  "Source and destination folders must differ": "Quell- und Zielordner müssen unterschiedlich sein",
  "Source and target conversation must be different": "Quell- und Zielunterhaltung müssen unterschiedlich sein",
  "Conversation was changed by another collaborator": "Die Unterhaltung wurde zwischenzeitlich geändert. Lade sie neu.",
  "Local tag was changed": "Der lokale Tag wurde zwischenzeitlich geändert. Lade ihn neu.",
  "Draft can no longer be edited": "Der Entwurf kann nicht mehr bearbeitet werden",
  "Draft can no longer accept attachments": "Dem Entwurf können keine Anhänge mehr hinzugefügt werden",
  "Draft is no longer available": "Der Entwurf ist nicht mehr verfügbar",
  "Draft or sender identity is not ready for sending": "Der Entwurf oder die Absenderidentität ist nicht versandbereit",
  "At least one recipient is required before sending": "Vor dem Versand ist mindestens ein Empfänger erforderlich",
  "Choose a scheduled send time at least 30 seconds in the future":
    "Wähle einen Versandzeitpunkt, der mindestens 30 Sekunden in der Zukunft liegt",
  "Delivery receipts are not supported by the selected SMTP server":
    "Der gewählte SMTP-Server unterstützt keine Zustellbestätigungen",
  "Rendered email content exceeds the safe size limit": "Der erzeugte E-Mail-Inhalt überschreitet die sichere Größenbegrenzung",
  "Email contains an invalid signature segment": "Die E-Mail enthält einen ungültigen Signaturabschnitt",
  "Markdown email is too complex to render safely": "Die Markdown-E-Mail ist zu komplex, um sie sicher darzustellen",
  "This remote image could not be loaded safely": "Dieses externe Bild konnte nicht sicher geladen werden",
  "Choose a writable Space": "Wähle einen beschreibbaren Space",
  "Write access to the selected Space is required": "Für den gewählten Space sind Schreibrechte erforderlich",
  "Choose a destination Space first": "Wähle zuerst einen Ziel-Space",
  "The selected Space has no active column for a new event": "Der gewählte Space hat keine aktive Spalte für einen neuen Termin",
  "Only an editable draft can receive an invitation": "Eine Einladung kann nur an einen bearbeitbaren Entwurf angehängt werden",
  "The draft sender identity is no longer verified": "Die Absenderidentität des Entwurfs ist nicht mehr bestätigt",
  "Add at least one To or Cc recipient before attaching an invitation":
    "Füge mindestens einen Empfänger unter An oder Cc hinzu, bevor du eine Einladung anhängst",
  "A verified sender identity is required": "Eine bestätigte Absenderidentität ist erforderlich",
  "The selected sender identity is not available": "Die gewählte Absenderidentität ist nicht verfügbar",
  "Automatic reply name already exists": "Eine automatische Antwort mit diesem Namen existiert bereits",
  "Disable the active automatic reply before enabling another one":
    "Deaktiviere die aktive automatische Antwort, bevor du eine andere aktivierst",
  "The advertised one-click unsubscribe link changed. Refresh subscriptions and try again.":
    "Der angegebene Ein-Klick-Abmeldelink hat sich geändert. Aktualisiere die Mailinglisten und versuche es erneut.",
  "An unsubscribe request is already in progress": "Eine Abmeldeanfrage wird bereits verarbeitet",
};

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
  return { ...error, message: germanMessages[error.message] ?? genericGermanMessage(error) };
};
