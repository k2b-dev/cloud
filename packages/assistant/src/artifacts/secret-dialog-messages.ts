import { i18n } from "@k2b/stdlib";
export const secretDialogMessages = i18n.define({ baseLocale: "en", messages: {
  en: {
    cancel: "Cancel", add: "Add secret", help: "Personal to you in this chat or app. Values are encrypted and never loaded again.",
    target: "Only this HTTPS origin receives the value. Paths and query parameters do not restrict access.",
    name: "Start with a letter; use letters, numbers, hyphens or underscores (up to 80 characters).",
    origin: "Enter a complete HTTPS address, e.g. https://api.example.com, without credentials or a fragment.",
    header: "Enter a valid authentication header, e.g. Authorization or X-API-Key. Reserved headers such as Cookie are not allowed.",
    prefix: "The prefix must not contain line breaks or unsupported characters.",
    value: "Enter a secret value without line breaks or unsupported characters.",
    duplicate: "This name already exists. Use Replace in the overview.",
    failed: "Could not save. Check your connection and try again.",
    conflict: "This secret changed. Reopen Replace from the refreshed overview.",
    auth: "Authentication", bearer: "Bearer token", apiKey: "API key", custom: "Custom", customPrefix: "Exact header prefix", scopeChat: "This chat", scopeApp: "This app",
  },
  de: {
    cancel: "Abbrechen", add: "Secret hinzufügen", help: "Persönlich für dich in diesem Chat oder dieser App. Werte werden verschlüsselt gespeichert und nie wieder geladen.",
    target: "Nur diese HTTPS-Origin erhält den Wert. Pfade und URL-Parameter schränken den Zugriff nicht ein.",
    name: "Beginne mit einem Buchstaben; erlaubt sind Buchstaben, Zahlen, Bindestriche und Unterstriche (maximal 80 Zeichen).",
    origin: "Gib eine vollständige HTTPS-Adresse ein, z. B. https://api.example.com, ohne Zugangsdaten oder Fragment.",
    header: "Gib einen gültigen Authentifizierungs-Header ein, z. B. Authorization oder X-API-Key. Reservierte Header wie Cookie sind nicht erlaubt.",
    prefix: "Das Präfix darf keine Zeilenumbrüche oder nicht unterstützten Zeichen enthalten.",
    value: "Gib einen Secret-Wert ohne Zeilenumbrüche oder nicht unterstützte Zeichen ein.",
    duplicate: "Dieser Name existiert bereits. Wähle Ersetzen in der Übersicht.",
    failed: "Speichern fehlgeschlagen. Prüfe deine Verbindung und versuche es erneut.",
    conflict: "Dieses Secret wurde geändert. Öffne Ersetzen erneut aus der aktualisierten Übersicht.",
    auth: "Authentifizierung", bearer: "Bearer-Token", apiKey: "API-Key", custom: "Benutzerdefiniert", customPrefix: "Exaktes Header-Präfix", scopeChat: "Dieser Chat", scopeApp: "Diese App",
  },
} });
