import { i18n } from "@k2b/stdlib";
export const errorMessages = i18n.define({ baseLocale: "en", messages: {
    en: {
      syntax: "Invalid JavaScript", definition: "Use export default kit.script({ name, run() {} })", keys: "Script metadata needs static, unique keys", metadata: "Invalid script metadata", literal: "Metadata must be a literal", dynamic: "Dynamic imports are not supported", entry: "Missing kit.script default export", relative: "Only relative JavaScript imports are allowed", escape: "Import escapes the project", extension: "Imports must include .js", duplicate: "Duplicate file", fileSize: "Source file too large", projectSize: "Project source too large", missing: "Missing module", noEntries: "Add at least one .script.js entrypoint", input: "Check the project name, file paths and size limits", compile: "The app could not be compiled", request: "The request failed. Please try again.", conflict: "This app was changed elsewhere. Your edits are preserved. Download your draft before loading the latest version.", denied: "You do not have permission for this action.", notFound: "This app or item no longer exists.", lastAdmin: "Keep at least one administrator for this app.", principal: "This recipient cannot be granted access.", user: "Sign in with a user account to use this app.", allocation: "The app could not be created. Please try again.",
    },
    de: {
      syntax: "Ungültiges JavaScript", definition: "Verwende export default kit.script({ name, run() {} })", keys: "Script-Metadaten brauchen feste, eindeutige Schlüssel", metadata: "Ungültige Script-Metadaten", literal: "Metadaten müssen ein Literal sein", dynamic: "Dynamische Imports werden nicht unterstützt", entry: "kit.script-Standardexport fehlt", relative: "Nur relative JavaScript-Imports sind erlaubt", escape: "Import verlässt das Projekt", extension: "Imports müssen auf .js enden", duplicate: "Doppelte Datei", fileSize: "Quelldatei ist zu groß", projectSize: "Projektquellcode ist zu groß", missing: "Modul fehlt", noEntries: "Füge mindestens einen .script.js-Einstiegspunkt hinzu", input: "Prüfe den Projektnamen, die Dateipfade und die Größenlimits", compile: "Die App konnte nicht kompiliert werden", request: "Die Anfrage ist fehlgeschlagen. Bitte versuche es erneut.", conflict: "Diese App wurde andernorts geändert. Dein Entwurf bleibt erhalten. Lade ihn herunter, bevor du die neueste Version lädst.", denied: "Dir fehlt die Berechtigung für diese Aktion.", notFound: "Diese App oder dieser Eintrag existiert nicht mehr.", lastAdmin: "Die App muss mindestens einen Administrator behalten.", principal: "Diesem Empfänger kann kein Zugriff erteilt werden.", user: "Melde dich mit einem Benutzerkonto an, um diese App zu benutzen.", allocation: "Die App konnte nicht erstellt werden. Bitte versuche es erneut.",
    },
  } });
export type ProjectReason = "syntax" | "definition" | "keys" | "metadata" | "literal" | "dynamic" | "entry" | "relative" | "escape" | "extension" | "duplicate" | "fileSize" | "projectSize" | "missing" | "noEntries" | "input" | "compile";
export class ProjectValidationError extends Error {
  constructor(public reason: ProjectReason, public detail = "", public path = "") { super([path, errorMessages.resolve().t[reason], detail].filter(Boolean).join(": ")); }
  localized(locale: string) { return [this.path, errorMessages.resolve([locale]).t[this.reason], this.detail].filter(Boolean).join(": "); }
}
export function apiErrorMessage(code: string, locale: string) {
  const t = errorMessages.resolve([locale]).t;
  switch (code) {
    case "REVISION_CONFLICT": return t.conflict;
    case "ACCESS_DENIED": return t.denied;
    case "NOT_FOUND": return t.notFound;
    case "LAST_ADMIN": return t.lastAdmin;
    case "INVALID_PRINCIPAL": return t.principal;
    case "USER_REQUIRED": return t.user;
    case "ID_ALLOCATION_FAILED": return t.allocation;
    case "INVALID_INPUT": return t.input;
    default: return t.request;
  }
}
