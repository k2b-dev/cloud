import { i18n } from "@k2b/stdlib";

/** What the chat shows while `code_run` connects, runs and waits, and why it gave up on a stalled identity service. */
export const codeRuntimeMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      connecting: "Connecting execution host",
      phase_starting: "Starting execution host",
      phase_running: "Executing code",
      phase_busy: "Waiting for current execution",
      phase_waiting_for_user: "Waiting for approval",
      identityTimeout: "The identity service did not respond in time. Check whether this call already started before running it again.",
    },
    de: {
      connecting: "Ausführungshost verbinden",
      phase_starting: "Ausführungshost startet",
      phase_running: "Code wird ausgeführt",
      phase_busy: "Wartet auf laufende Ausführung",
      phase_waiting_for_user: "Wartet auf Freigabe",
      identityTimeout:
        "Der Identitätsdienst hat nicht rechtzeitig geantwortet. Prüfe, ob dieser Aufruf schon gestartet ist, bevor du ihn erneut ausführst.",
    },
  },
});
