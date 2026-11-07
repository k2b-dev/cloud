import {
  Avatar,
  Button,
  Checkbox,
  InlineGuidance,
  Paper,
  QrScanner,
  type QrScannerError,
  SignatureInput,
  type SignatureValue,
} from "@k2b/ui";
import { createEffect, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { type KioskApi, KioskFailure, type KioskSnapshot, type VisitView } from "./model";

type State =
  | "ready"
  | "scanning"
  | "loading"
  | "saving"
  | "unknown"
  | "conflict"
  | "offline"
  | "expired"
  | "forbidden"
  | "ending"
  | "ended"
  | "completed";
const cameraMessages: Record<QrScannerError, string> = {
  denied: "Der Kamerazugriff ist aus. Erlauben Sie ihn in den Einstellungen und starten Sie den Scanner erneut.",
  "no-camera": "Keine Kamera gefunden. Bitte prüfen Sie das Gerät mit den Mitarbeitenden.",
  "in-use": "Die Kamera wird bereits verwendet. Schließen Sie die andere Kamera-Anwendung und versuchen Sie es erneut.",
  unavailable: "Die Kamera konnte nicht starten. Prüfen Sie die Verbindung und versuchen Sie es erneut.",
};
const states = {
  completed: ["Alles unterschrieben.", "Der Abschluss wurde bestätigt. Die Sitzung ist geschlossen und Ihre Dokumente sind ausgeblendet."],
  loading: ["Vorgang wird geprüft.", "Wir prüfen die Sitzung und die angebotenen Dokumente. Kundendaten erscheinen erst danach."],
  saving: ["Unterschrift wird gespeichert.", "Bitte warten Sie auf die Bestätigung. Schließen Sie diesen Schritt nicht erneut ab."],
  unknown: [
    "Ist die Unterschrift angekommen?",
    "Die Antwort fehlt. Wir prüfen denselben Versuch, bevor Sie weitermachen. Bitte nicht erneut unterschreiben.",
  ],
  conflict: [
    "Das Dokument wurde geändert.",
    "Bitte lesen Sie die neue Fassung. Ihre bisherige Unterschrift wird nicht auf die neue Fassung übertragen.",
  ],
  offline: [
    "Verbindung unterbrochen.",
    "Kundendaten bleiben ausgeblendet. Sobald die Verbindung zurück ist, prüfen wir die Sitzung erneut.",
  ],
  expired: ["Die Sitzung ist abgelaufen.", "Der Zugang ist geschlossen. Bitten Sie Mitarbeitende um einen neuen QR."],
  forbidden: [
    "Dieser Vorgang ist nicht verfügbar.",
    "Der Zugang wurde beendet oder das Dokument ist nicht mehr freigegeben. Bitte sprechen Sie mit Mitarbeitenden.",
  ],
  ending: [
    "Beenden wird geprüft.",
    "Der Bildschirm ist geschlossen. Der Server hat das Ende noch nicht bestätigt. Bitte geben Sie das iPad noch nicht weiter.",
  ],
  ended: [
    "Die Sitzung ist beendet.",
    "Ihre Dokumente sind auf diesem Bildschirm geschlossen. Das iPad ist bereit für den nächsten Kunden.",
  ],
} as const;

/** All sensitive state lives only in this mounted view. A stale response can never reveal it after pagehide. */
export default function Kiosk(props: { initial: KioskSnapshot; api: KioskApi }) {
  const [device, setDevice] = createSignal(props.initial.device);
  const [visit, setVisit] = createSignal<VisitView | null>(props.initial.visit);
  const [state, setState] = createSignal<State>("ready");
  const [notice, setNotice] = createSignal("");
  const [signature, setSignature] = createSignal<SignatureValue | null>(null);
  const [consent, setConsent] = createSignal(false);
  const [signatureKey, setSignatureKey] = createSignal(1);
  const [mounted, setMounted] = createSignal(false);
  let generation = 0;
  let active: AbortController | undefined;
  let pendingAttempt: string | undefined;
  let endingAttempt: string | undefined;
  let readInFlight = false;
  let completionConfirmed = false;
  let main: HTMLElement | undefined;
  let focusKey = "";
  const document = () => visit()?.documents.find((item) => !item.signed);
  const done = () => Boolean(visit()?.documents.length && !document());
  const resetInk = () => {
    setSignature(null);
    setConsent(false);
    setSignatureKey((key) => key + 1);
  };
  const conceal = () => {
    generation++;
    active?.abort();
    active = undefined;
    readInFlight = false;
    setVisit(null);
    resetInk();
  };
  const start = () => {
    active?.abort();
    active = new AbortController();
    const current = ++generation;
    return { signal: active.signal, current };
  };
  const visible = (current: number) => current === generation && globalThis.document.visibilityState === "visible";
  const failure = (error: unknown, fallback: State = "offline") => {
    setVisit(null);
    resetInk();
    if (error instanceof KioskFailure) {
      if (error.code === "qr_unavailable") {
        setState("ready");
        setNotice("Dieser QR ist nicht mehr verfügbar. Bitten Sie Mitarbeitende um einen neuen QR.");
      } else setState(error.code === "unavailable" ? fallback : error.code);
    } else setState(fallback);
  };
  const apply = (next: KioskSnapshot) => {
    const previous = document();
    const nextDocument = next.visit?.documents.find((item) => !item.signed);
    if (visit()?.id !== next.visit?.id || previous?.id !== nextDocument?.id || previous?.revision !== nextDocument?.revision) resetInk();
    setDevice(next.device);
    setVisit(next.visit);
    setState("ready");
  };
  const refresh = async (passive = false) => {
    if (readInFlight || globalThis.document.visibilityState !== "visible") return;
    if (passive && state() !== "ready") return;
    const operation = start();
    readInFlight = true;
    if (!passive) {
      setVisit(null);
      resetInk();
      setState(pendingAttempt ? "unknown" : "loading");
    }
    try {
      if (pendingAttempt) {
        const result = await props.api.reconcile(pendingAttempt, operation.signal);
        if (!visible(operation.current)) return;
        pendingAttempt = undefined;
        if (result === "completed") {
          completionConfirmed = true;
          setState("completed");
          return;
        }
        if (result === "absent") setNotice("Es wurde keine Unterschrift gespeichert. Bitte lesen und unterschreiben Sie erneut.");
      }
      const snapshot = await props.api.snapshot(operation.signal);
      if (visible(operation.current)) apply(snapshot);
    } catch (error) {
      if (visible(operation.current)) failure(error, pendingAttempt ? "unknown" : "offline");
    } finally {
      if (operation.current === generation) readInFlight = false;
    }
  };
  const scan = (text: string) => {
    if (!props.api.acceptsQr(text)) return false;
    pendingAttempt = undefined;
    completionConfirmed = false;
    conceal();
    setState("loading");
    setNotice("");
    const operation = start();
    void props.api
      .scan(text, operation.signal)
      .then(async () => {
        if (visible(operation.current)) await refresh();
      })
      .catch((error: unknown) => {
        if (visible(operation.current)) failure(error);
      });
    return true;
  };
  const sign = async () => {
    const item = document();
    const ink = signature();
    if (!item || !ink || !consent() || state() !== "ready" || pendingAttempt) return;
    pendingAttempt = crypto.randomUUID();
    const attempt = pendingAttempt;
    const input = { documentId: item.id, revision: item.revision, signature: ink, consent: true as const };
    conceal();
    setState("saving");
    const operation = start();
    try {
      const result = await props.api.sign(attempt, input, operation.signal);
      if (!visible(operation.current)) return;
      pendingAttempt = undefined;
      setNotice("");
      if (result?.completed) {
        completionConfirmed = true;
        setState("completed");
        return;
      }
      await refresh();
    } catch (error) {
      if (!visible(operation.current)) return;
      if (error instanceof KioskFailure && ["conflict", "expired", "forbidden"].includes(error.code)) {
        pendingAttempt = undefined;
        failure(error);
      } else setState("unknown");
    }
  };
  const end = async () => {
    endingAttempt ??= crypto.randomUUID();
    conceal();
    setState("ending");
    const operation = start();
    try {
      await props.api.end(endingAttempt, operation.signal);
      if (!visible(operation.current)) return;
      endingAttempt = undefined;
      pendingAttempt = undefined;
      completionConfirmed = false;
      setState("ended");
    } catch {
      if (visible(operation.current)) setNotice("Das Ende ist noch nicht bestätigt. Bitte prüfen Sie den Status erneut.");
    }
  };
  const recover = () => (endingAttempt ? void end() : completionConfirmed ? setState("completed") : void refresh());
  const openScanner = () => {
    conceal();
    setNotice("");
    setState("scanning");
  };
  onMount(() => {
    setMounted(true);
    // QR secrets from a manually opened URL never survive in history or reach navigation.
    if (location.hash) history.replaceState(history.state, "", location.pathname);
    const hide = () => {
      conceal();
      setState(endingAttempt ? "ending" : pendingAttempt ? "unknown" : "loading");
    };
    const visibility = () => (globalThis.document.visibilityState === "visible" ? recover() : hide());
    const show = () => recover();
    const offline = () => {
      conceal();
      setState(endingAttempt ? "ending" : pendingAttempt ? "unknown" : "offline");
    };
    globalThis.document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    window.addEventListener("popstate", show);
    window.addEventListener("offline", offline);
    // The example follows the visit flow's 2-second status cadence. Reads never count as activity.
    if (!props.initial.visit) void refresh();
    const poll = setInterval(() => {
      void refresh(true);
    }, 2_000);
    onCleanup(() => {
      conceal();
      clearInterval(poll);
      globalThis.document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      window.removeEventListener("popstate", show);
      window.removeEventListener("offline", offline);
    });
  });
  createEffect(() => {
    const key = `${mounted()}:${state()}:${document()?.id ?? ""}:${document()?.revision ?? ""}`;
    if (!mounted() || key === focusKey) return;
    focusKey = key;
    const current = generation;
    queueMicrotask(() => {
      if (visible(current)) {
        const heading = main?.querySelector("h1");
        heading?.setAttribute("tabindex", "-1");
        heading?.focus();
      }
    });
  });
  const statusText = () => {
    const value = state();
    return value === "ready" || value === "scanning" ? undefined : states[value];
  };
  return (
    <Paper as="section" class="kiosk" aria-label="Laden-iPad">
      <header class="kiosk-head">
        <span class="kiosk-brand">
          <i class="ti ti-signature" aria-hidden="true" /> Laden-iPad
        </span>
        <span class="kiosk-muted">Besuchsbeispiel</span>
      </header>
      <main ref={main} class="kiosk-main" data-print-region>
        <Switch>
          <Match when={statusText()}>
            {(text) => (
              <div class="kiosk-welcome">
                <h1 tabIndex={-1}>{text()[0]}</h1>
                <p class="kiosk-muted">{text()[1]}</p>
                <InlineGuidance class="kiosk-status" role="status" loading={["loading", "saving"].includes(state())}>
                  {notice() || (["loading", "saving"].includes(state()) ? "Bitte warten …" : "")}
                </InlineGuidance>
                <Show when={!["loading", "saving"].includes(state())}>
                  <Button class="kiosk-full" size="lg" onClick={() => (state() === "completed" ? void end() : recover())}>
                    {state() === "completed"
                      ? "Sitzung beenden"
                      : state() === "unknown"
                        ? "Speicherstatus prüfen"
                        : state() === "ending"
                          ? "Status erneut prüfen"
                          : state() === "conflict"
                            ? "Neue Fassung lesen"
                            : ["ended", "expired", "forbidden"].includes(state())
                              ? "Zum Scanner"
                              : "Verbindung erneut prüfen"}
                  </Button>
                </Show>
              </div>
            )}
          </Match>
          <Match when={state() === "scanning"}>
            <div class="kiosk-welcome">
              <h1>QR scannen</h1>
              <QrScanner
                onResult={scan}
                onStop={() => setState("ready")}
                onError={(reason) => {
                  setNotice(cameraMessages[reason]);
                  setState("ready");
                }}
                instructions="Scannen Sie den QR vom Mitarbeiterbildschirm."
              />
              <Button variant="secondary" class="kiosk-full" onClick={() => setState("ready")}>
                Abbrechen
              </Button>
            </div>
          </Match>
          <Match when={!visit()}>
            <div class="kiosk-welcome">
              <h1>
                {device() ? (
                  <>
                    Ihr Vorgang.
                    <br />
                    In Ruhe unterschreiben.
                  </>
                ) : (
                  "Laden-iPad koppeln"
                )}
              </h1>
              <p class="kiosk-muted">
                {device()
                  ? "Scannen Sie den QR Ihres Besuchs vom Mitarbeiterbildschirm. Sie brauchen kein Cloud-Konto."
                  : "Öffnen Sie „Laden-iPad koppeln“ am Mitarbeiterbildschirm und scannen Sie den QR."}
              </p>
              <div class="kiosk-scan-art" aria-hidden="true">
                <i class="ti ti-scan" />
              </div>
              <Button size="lg" class="kiosk-full" disabled={!mounted()} onClick={openScanner}>
                {notice() ? "Erneut versuchen" : "QR scannen"}
              </Button>
              <InlineGuidance role="status" class="kiosk-status">
                {notice() || "Die Kamera startet erst, wenn Sie auf „QR scannen“ tippen."}
              </InlineGuidance>
            </div>
          </Match>
          <Match when={done()}>
            <div class="kiosk-welcome">
              <h1>Alles unterschrieben.</h1>
              <p class="kiosk-muted">Vertrag und Quittung sind abgeschlossen. Sie können die Sitzung jetzt beenden.</p>
              <dl class="kiosk-summary">
                <For each={visit()?.documents}>
                  {(item) => (
                    <div>
                      <dt>{item.title}</dt>
                      <dd>Unterschrieben</dd>
                    </div>
                  )}
                </For>
              </dl>
              <InlineGuidance tone="success" class="kiosk-status" role="status">
                Beide Speicherungen sind bestätigt.
              </InlineGuidance>
              <Button size="lg" class="kiosk-full" onClick={() => void end()}>
                Sitzung beenden
              </Button>
            </div>
          </Match>
          <Match when={document()}>
            {(item) => (
              <>
                <ol class="kiosk-steps" aria-label="Dokumente">
                  <For each={visit()?.documents}>
                    {(entry, index) => (
                      <li aria-current={entry.id === item().id ? "step" : undefined}>
                        {index() + 1}. {entry.title}
                        {entry.signed ? " ✓" : ""}
                      </li>
                    )}
                  </For>
                </ol>
                <h1>{item().receiptAmount ? "Auszahlung bestätigen" : "Ankaufsvertrag lesen"}</h1>
                <p class="kiosk-muted">
                  {item().receiptAmount
                    ? "Bitte prüfen Sie den Betrag und bestätigen Sie den Empfang."
                    : "Prüfen Sie die Angaben. Fragen klären die Mitarbeitenden mit Ihnen."}
                </p>
                <div class="kiosk-customer">
                  <Avatar name={visit()?.customerName ?? ""} size="md" />
                  <strong>{visit()?.customerName}</strong>
                </div>
                <Paper as="article" class="kiosk-document" aria-label="Dokumentvorschau">
                  <div class="kiosk-row">
                    <h2>{item().title}</h2>
                    <span class="kiosk-muted">Fassung {item().revision}</span>
                  </div>
                  <Show when={item().receiptAmount}>{(amount) => <p class="kiosk-amount">{amount()}</p>}</Show>
                  <For each={item().paragraphs}>{(paragraph) => <p>{paragraph}</p>}</For>
                </Paper>
                <Show when={signatureKey()} keyed>
                  {(_key) => (
                    <SignatureInput
                      label="Ihre Unterschrift"
                      value={signature()}
                      onValueChange={setSignature}
                      description="Nur für dieses Dokument. Unfertige Unterschriften gehen beim Verlassen verloren."
                    />
                  )}
                </Show>
                <Checkbox
                  label={
                    item().receiptAmount
                      ? "Ich bestätige den Empfang des oben genannten Betrags."
                      : "Ich habe die Angaben gelesen und möchte diesen Vertrag abschließen."
                  }
                  value={consent()}
                  onValueChange={setConsent}
                />
                <InlineGuidance role="status" class="kiosk-status">
                  {notice() || "Die Unterschrift wird erst mit Ihrer Bestätigung abgeschlossen."}
                </InlineGuidance>
                <Button size="lg" class="kiosk-full" disabled={!mounted() || !signature() || !consent()} onClick={() => void sign()}>
                  {item().receiptAmount ? "Empfang unterschreiben" : "Vertrag unterschreiben"}
                </Button>
                <div class="kiosk-end">
                  <span class="kiosk-muted">Beispieldaten · keine rechtliche Signatur</span>
                  <Button variant="text" onClick={() => void end()}>
                    Sitzung beenden
                  </Button>
                </div>
              </>
            )}
          </Match>
          <Match when={visit()}>
            <div class="kiosk-welcome">
              <h1>Noch kein Dokument bereit.</h1>
              <p class="kiosk-muted">Mitarbeitende müssen zuerst einen Vertrag für diesen Vorgang vorbereiten.</p>
              <Button onClick={() => void refresh()}>Erneut prüfen</Button>
              <Button variant="text" onClick={() => void end()}>
                Sitzung beenden
              </Button>
            </div>
          </Match>
        </Switch>
      </main>
      <footer class="kiosk-foot">
        <span>Persönlicher Vorgang</span>
        <span>Bei Fragen helfen Ihnen die Mitarbeitenden.</span>
      </footer>
    </Paper>
  );
}
