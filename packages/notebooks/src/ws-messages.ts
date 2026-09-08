import { i18n } from "@k2b/stdlib";

const catalog = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      accessRevoked: "Access was revoked",
      accessDenied: "Access denied",
      writeAccessRequired: "Write access required",
      noteLocked: "Note is locked",
      noteNotFound: "Note not found",
      notebookNotFound: "Notebook not found",
      sessionExpired: "Session expired",
      accessRefreshFailed: "Access refresh failed",
      workspaceAccessRevoked: "Workspace access revoked",
      workspaceAccessRefreshFailed: "Workspace access refresh failed",
      liveAwarenessStreamFailed: "Live awareness stream failed",
      liveSyncStreamFailed: "Live sync stream failed",
      workspaceStreamFailed: "Workspace event stream failed",
      messageNotAllowed: ({ type, phase }: { type: string; phase: string }) => `Message "${type}" is not allowed in phase "${phase}"`,
      replayRequired: "Replay request required before publishing",
      loginRequired: "Login required",
      invalidBase64: "Invalid base64 payload",
      invalidSyncUpdate: "Invalid Yjs update payload",
      invalidJson: "Invalid JSON payload",
      invalidMessage: "Invalid message payload",
      jsonTextOnly: "Only JSON text messages are supported",
      messageTooLarge: "Websocket message is too large",
      tooManyMessages: "Too many pending websocket messages",
      handlingFailed: "Message handling failed",
    },
    de: {
      accessRevoked: "Der Zugriff wurde entzogen",
      accessDenied: "Zugriff verweigert",
      writeAccessRequired: "Schreibzugriff erforderlich",
      noteLocked: "Die Notiz ist gesperrt",
      noteNotFound: "Die Notiz wurde nicht gefunden",
      notebookNotFound: "Das Notizbuch wurde nicht gefunden",
      sessionExpired: "Die Sitzung ist abgelaufen",
      accessRefreshFailed: "Die Zugriffsprüfung ist fehlgeschlagen",
      workspaceAccessRevoked: "Der Zugriff auf den Arbeitsbereich wurde entzogen",
      workspaceAccessRefreshFailed: "Die Zugriffsprüfung für den Arbeitsbereich ist fehlgeschlagen",
      liveAwarenessStreamFailed: "Der Live-Präsenzstrom ist fehlgeschlagen",
      liveSyncStreamFailed: "Der Live-Synchronisierungsstrom ist fehlgeschlagen",
      workspaceStreamFailed: "Der Ereignisstrom des Arbeitsbereichs ist fehlgeschlagen",
      messageNotAllowed: ({ type, phase }: { type: string; phase: string }) =>
        `Die Nachricht "${type}" ist in der Phase "${phase}" nicht erlaubt`,
      replayRequired: "Vor dem Veröffentlichen ist eine Wiedergabeanfrage erforderlich",
      loginRequired: "Anmeldung erforderlich",
      invalidBase64: "Die Base64-Daten sind ungültig",
      invalidSyncUpdate: "Die Yjs-Aktualisierung ist ungültig",
      invalidJson: "Die JSON-Daten sind ungültig",
      invalidMessage: "Die Nachrichtendaten sind ungültig",
      jsonTextOnly: "Nur JSON-Textnachrichten werden unterstützt",
      messageTooLarge: "Die WebSocket-Nachricht ist zu groß",
      tooManyMessages: "Zu viele ausstehende WebSocket-Nachrichten",
      handlingFailed: "Die Verarbeitung der Nachricht ist fehlgeschlagen",
    },
  },
});

export type NotebooksWsMessages = ReturnType<typeof catalog.resolve>["t"];
export const notebooksWsMessages = (locale?: string | null) => catalog.resolve(locale ? [locale] : []).t;
export const checkNotebooksWsMessages = () => catalog.check();
