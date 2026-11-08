import { i18n } from "@k2b/stdlib";

/** Words Cloud adds around a Code page. The Code's own texts are never translated. */
export const codePageMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      yes: "Yes",
      asOf: ({ time }: { time: string }) => `As of ${time}`,
      points: "pts",
      chartEmpty: "Nothing to show yet.",
      no: "No",
      scan: "Scan",
      scanTitle: "Scan code",
      closeScanner: "Close scanner",
      scanInstructions: "Point the camera at the code.",
      cameraDenied: "Camera access is off. Allow it in the browser settings, or type the code.",
      cameraMissing: "No camera was found. Type the code instead.",
      cameraInUse: "The camera is busy or could not start. Close other apps that use it, or type the code.",
      cameraUnavailable: "The camera could not start. Type the code instead.",
      sending: "Sending…",
      newData: "This page has new data.",
      refresh: "Refresh",
      retry: "Try again",
      refreshFailed: "Could not load the page again.",
      actionFailed: "The action did not complete.",
      signInRequired: "Your session ended. Sign in again and repeat the step.",
      ownerOnly: "Only the owner of this Code can use this page.",
      csrfRequired: "This page is out of date. Reload it and repeat the step.",
      rateLimited: "Too many requests. Wait a minute and try again.",
      timeout: "The Code did not answer in time. Check the result before you try again.",
      busy: "The Code is busy. Try again in a moment.",
      unavailable: "The Code could not answer. Try again later.",
      tooLarge: "The input is too large.",
      answerLost: "The answer was lost. Check whether the step took effect before you send it again.",
    },
    de: {
      yes: "Ja",
      asOf: ({ time }) => `Stand ${time}`,
      points: "Pkt.",
      chartEmpty: "Noch nichts zu zeigen.",
      no: "Nein",
      scan: "Scannen",
      scanTitle: "Code scannen",
      closeScanner: "Scanner schließen",
      scanInstructions: "Halte die Kamera auf den Code.",
      cameraDenied: "Der Kamerazugriff ist aus. Erlaube ihn in den Browser-Einstellungen oder tippe den Code ein.",
      cameraMissing: "Keine Kamera gefunden. Tippe den Code ein.",
      cameraInUse: "Die Kamera ist belegt oder startet nicht. Schließe andere Apps, die sie nutzen, oder tippe den Code ein.",
      cameraUnavailable: "Die Kamera startet nicht. Tippe den Code ein.",
      sending: "Wird gesendet…",
      newData: "Diese Seite hat neue Daten.",
      refresh: "Aktualisieren",
      retry: "Erneut versuchen",
      refreshFailed: "Die Seite konnte nicht neu geladen werden.",
      actionFailed: "Die Aktion wurde nicht abgeschlossen.",
      signInRequired: "Deine Sitzung ist abgelaufen. Melde dich neu an und wiederhole den Schritt.",
      ownerOnly: "Nur wer diesen Code besitzt, kann diese Seite nutzen.",
      csrfRequired: "Diese Seite ist veraltet. Lade sie neu und wiederhole den Schritt.",
      rateLimited: "Zu viele Anfragen. Warte eine Minute und versuche es erneut.",
      timeout: "Der Code hat nicht rechtzeitig geantwortet. Prüfe das Ergebnis, bevor du es erneut versuchst.",
      busy: "Der Code ist ausgelastet. Versuche es gleich noch einmal.",
      unavailable: "Der Code konnte nicht antworten. Versuche es später erneut.",
      tooLarge: "Die Eingabe ist zu groß.",
      answerLost: "Die Antwort ging verloren. Prüfe, ob der Schritt gewirkt hat, bevor du ihn erneut sendest.",
    },
  },
});
export type CodePageMessages = ReturnType<typeof codePageMessages.resolve>["t"];

/** Hosting answers with stable codes; the page names them in the reader's language. */
export function codePageFailure(t: CodePageMessages, code: string | undefined, fallback: string): string {
  switch (code) {
    case "code_sign_in_required":
      return t.signInRequired;
    case "code_owner_only":
      return t.ownerOnly;
    case "code_csrf_required":
      return t.csrfRequired;
    case "code_request_rate_limit":
      return t.rateLimited;
    case "code_request_timeout":
      return t.timeout;
    case "code_request_busy":
      return t.busy;
    case "code_request_size_limit":
      return t.tooLarge;
    case "code_answer_lost":
      return t.answerLost;
    case "code_request_failed":
    case "code_route_changed":
      return t.unavailable;
    default:
      return fallback;
  }
}
