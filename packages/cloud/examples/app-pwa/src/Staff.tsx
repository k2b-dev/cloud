import { qr } from "@k2b/stdlib/qr";
import { Button, InlineGuidance, Paper, TextInput } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { HttpFailure } from "./http";
import { KioskFailure } from "./model";

export type DeviceView = { id: string; name: string; state: "pending" | "active" | "revoked" | "expired"; expiresAt: string | null };
export type DevicePage = { items: DeviceView[]; next: string | null };
type QrResult = { id: string; qr: string | null; qrExpiresAt: string };
export type StaffApi = {
  list(signal: AbortSignal, after?: string): Promise<DevicePage>;
  status(id: string, signal: AbortSignal): Promise<DeviceView>;
  pair(requestId: string, name: string, signal: AbortSignal): Promise<QrResult & DeviceView>;
  revoke(id: string, signal: AbortSignal): Promise<void>;
  visit(requestId: string, deviceId: string, signal: AbortSignal): Promise<QrResult>;
};
type Code = { image: string; expiresAt: number; kind: "device" | "visit"; deviceId: string };

/** Every staff action is independently authorized by the platform service. */
export default function Staff(props: { initial: DevicePage; initialError?: boolean; api: StaffApi }) {
  const [pages, setPages] = createSignal([props.initial]);
  const [name, setName] = createSignal("Laden-iPad");
  const [pairingId, setPairingId] = createSignal<string>();
  const [pairingDevice, setPairingDevice] = createSignal<DeviceView>();
  const [code, setCode] = createSignal<Code>();
  const [busy, setBusy] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(props.initialError ? "Die Geräteliste konnte nicht geladen werden. Bitte erneut versuchen." : "");
  const [ready, setReady] = createSignal(false);
  const [denied, setDenied] = createSignal(false);
  const [now, setNow] = createSignal(0);
  const [retry, setRetry] = createSignal<"pair" | "visit" | "revoke">();
  const [pairPending, setPairPending] = createSignal(false);
  const [expiredRequest, setExpiredRequest] = createSignal<{ kind: "pair" | "visit"; deviceId?: string }>();
  let pairing: { requestId: string; name: string } | undefined;
  let visitRequest: { requestId: string; deviceId: string } | undefined;
  let revokeId: string | undefined;
  let operation: AbortController | undefined;
  let poll: AbortController | undefined;
  let generation = 0;
  let disposed = false;
  const devices = () => pages().flatMap((page) => page.items);
  const next = () => pages().at(-1)?.next;
  const paired = () => {
    const current = pairingDevice() ?? devices().find((device) => device.id === pairingId());
    return current?.state === "active" ? current : undefined;
  };
  const alive = (signal: AbortSignal, current: number) => !disposed && !signal.aborted && current === generation;
  const refresh = async (more = false) => {
    if (poll || document.visibilityState !== "visible") return;
    const current = generation;
    const controller = new AbortController();
    poll = controller;
    setLoading(true);
    try {
      const loaded: DevicePage[] = [];
      if (more) {
        const cursor = next();
        if (!cursor) return;
        const page = await props.api.list(controller.signal, cursor);
        if (alive(controller.signal, current)) setPages((old) => [...old, page]);
      } else {
        // Poll only the number of pages the employee explicitly loaded.
        let after: string | undefined;
        for (let index = 0; index < pages().length; index++) {
          const page = await props.api.list(controller.signal, after);
          loaded.push(page);
          if (!page.next) break;
          after = page.next;
        }
        const currentId = pairingId();
        const currentDevice = currentId ? await props.api.status(currentId, controller.signal) : undefined;
        if (alive(controller.signal, current) && currentId === pairingId()) {
          setPairingDevice(currentDevice);
          setPages(loaded);
          if (paired()?.id === code()?.deviceId && code()?.kind === "device") setCode(undefined);
          if (!retry()) setError("");
        }
      }
    } catch (error) {
      if (alive(controller.signal, current)) {
        if (error instanceof HttpFailure && [401, 403].includes(error.status)) {
          setDenied(true);
          setError("Ihr Mitarbeiterzugang ist nicht mehr verfügbar. Laden Sie die Seite neu, um den Zugang zu prüfen.");
        } else setError("Die Geräteliste konnte nicht geladen werden. Bitte erneut versuchen.");
      }
    } finally {
      if (poll === controller) {
        poll = undefined;
        if (!disposed) setLoading(false);
      }
    }
  };
  const run = async (kind: "pair" | "visit" | "revoke", work: (signal: AbortSignal, current: number) => Promise<void>) => {
    if (busy()) return;
    // An earlier poll belongs to the previous action. Even a transport that
    // ignores abort must not overwrite a newly issued QR or a revocation.
    generation++;
    poll?.abort();
    poll = undefined;
    setLoading(false);
    setBusy(true);
    setError("");
    setExpiredRequest(undefined);
    const controller = new AbortController();
    operation = controller;
    const current = generation;
    try {
      await work(controller.signal, current);
      if (alive(controller.signal, current)) setRetry(undefined);
    } catch (error) {
      if (alive(controller.signal, current)) {
        if (error instanceof HttpFailure && [401, 403].includes(error.status)) {
          setDenied(true);
          setRetry(undefined);
          setError("Ihr Mitarbeiterzugang ist nicht mehr verfügbar. Laden Sie die Seite neu, um den Zugang zu prüfen.");
          return;
        }
        if ((error instanceof HttpFailure && error.code === "EXPIRED") || (error instanceof KioskFailure && error.code === "expired")) {
          if (kind === "pair") {
            pairing = undefined;
            setPairPending(false);
            setExpiredRequest({ kind: "pair" });
          }
          if (kind === "visit") {
            setExpiredRequest({ kind: "visit", deviceId: visitRequest?.deviceId });
            visitRequest = undefined;
          }
          setRetry(undefined);
          setError("Dieser QR ist abgelaufen. Fordern Sie einen neuen QR für denselben Schritt an.");
          return;
        }
        setRetry(kind);
        setError("Die Antwort fehlt. Prüfen Sie den Status oder wiederholen Sie dieselbe Anfrage.");
      }
    } finally {
      if (operation === controller) {
        operation = undefined;
        if (!disposed) setBusy(false);
      }
    }
  };
  const showQr = (value: QrResult, kind: "device" | "visit", deviceId: string) => {
    setNow(Date.now());
    if (!value.qr) {
      setCode(undefined);
      return;
    }
    setCode({
      image: `data:image/svg+xml,${encodeURIComponent(qr.toSvg(value.qr, { on: "#000000", off: "#ffffff", correctionLevel: "M" }))}`,
      expiresAt: Date.parse(value.qrExpiresAt),
      kind,
      deviceId,
    });
  };
  const pair = () =>
    run("pair", async (signal, current) => {
      pairing ??= { requestId: crypto.randomUUID(), name: name().trim() };
      setPairPending(true);
      const result = await props.api.pair(pairing.requestId, pairing.name, signal);
      if (!alive(signal, current)) return;
      setPairingId(result.id);
      setPairingDevice(result);
      showQr(result, "device", result.id);
      pairing = undefined;
      setPairPending(false);
      setRetry(undefined);
      await refresh();
    });
  const revoke = (id: string) =>
    run("revoke", async (signal, current) => {
      revokeId = id;
      await props.api.revoke(id, signal);
      if (!alive(signal, current)) return;
      if (pairingId() === id) {
        setCode(undefined);
        setPairingId(undefined);
        setPairingDevice(undefined);
      }
      revokeId = undefined;
      setRetry(undefined);
      await refresh();
    });
  const visit = (id: string) =>
    run("visit", async (signal, current) => {
      if (visitRequest?.deviceId !== id) visitRequest = { requestId: crypto.randomUUID(), deviceId: id };
      const result = await props.api.visit(visitRequest.requestId, id, signal);
      if (!alive(signal, current)) return;
      showQr(result, "visit", id);
      visitRequest = undefined;
      setRetry(undefined);
      if (!result.qr) setError("Dieser Besuch wurde bereits geöffnet. Für einen weiteren Kunden einen neuen Besuchs-QR zeigen.");
    });
  const retryAction = () =>
    retry() === "pair"
      ? pair()
      : retry() === "visit" && visitRequest
        ? visit(visitRequest.deviceId)
        : revokeId
          ? revoke(revokeId)
          : refresh();
  const newQr = () => {
    const previous = code();
    setCode(undefined);
    if (previous?.kind === "visit") {
      visitRequest = undefined;
      void visit(previous.deviceId);
    } else {
      pairing = undefined;
      setPairPending(false);
      void pair();
    }
  };
  onMount(() => {
    setReady(true);
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
      if (!busy() && !retry()) void refresh();
    }, 2_000);
    const hide = () => {
      generation++;
      operation?.abort();
      poll?.abort();
      operation = undefined;
      poll = undefined;
      setCode(undefined);
      setBusy(false);
      setLoading(false);
      if (pairing) setRetry("pair");
      else if (visitRequest) setRetry("visit");
      else if (revokeId) setRetry("revoke");
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
      else hide();
    };
    const show = () => {
      void refresh();
    };
    const offline = () => {
      hide();
      setError("Die Verbindung ist unterbrochen. Prüfen Sie den Status, sobald sie zurück ist.");
    };
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    window.addEventListener("offline", offline);
    onCleanup(() => {
      disposed = true;
      hide();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
      window.removeEventListener("offline", offline);
    });
  });
  return (
    <Paper as="section" class="kiosk-staff">
      <header class="kiosk-row">
        <div>
          <h1>Laden-iPad koppeln</h1>
          <p class="kiosk-muted">Zeigen Sie den QR auf diesem Bildschirm. Das iPad scannt ihn mit seiner App-PWA.</p>
        </div>
      </header>
      <div class="kiosk-staff-grid">
        <section>
          <TextInput
            label="Gerätename"
            value={name()}
            maxLength={80}
            onValueChange={setName}
            disabled={busy() || denied() || pairPending()}
          />
          <Button
            size="lg"
            disabled={!ready() || denied() || !name().trim() || Boolean(retry())}
            loading={busy()}
            onClick={() => void pair()}
          >
            Laden-iPad koppeln
          </Button>
          <h2>Ihre Geräte</h2>
          <Show
            when={devices().length}
            fallback={
              <p class="kiosk-muted">
                {loading() ? "Geräte werden geladen …" : error() ? "Geräteliste nicht verfügbar." : "Noch kein Laden-iPad gekoppelt."}
              </p>
            }
          >
            <ul class="kiosk-device-list">
              <For each={devices()}>
                {(device) => (
                  <li>
                    <div>
                      <strong>{device.name}</strong>
                      <p class="kiosk-muted">
                        {device.state === "active"
                          ? "Gekoppelt"
                          : device.state === "pending"
                            ? "Wartet auf Scan"
                            : device.state === "expired"
                              ? "Abgelaufen"
                              : "Widerrufen"}
                      </p>
                    </div>
                    <div class="kiosk-row">
                      <Show when={device.state === "active"}>
                        <Button variant="secondary" disabled={busy() || denied() || Boolean(retry())} onClick={() => void visit(device.id)}>
                          Besuchs-QR zeigen
                        </Button>
                      </Show>
                      <Show when={["active", "pending"].includes(device.state)}>
                        <Button variant="danger" disabled={busy() || denied() || Boolean(retry())} onClick={() => void revoke(device.id)}>
                          Widerrufen
                        </Button>
                      </Show>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={next()}>
            <Button variant="secondary" disabled={busy() || denied()} loading={loading()} onClick={() => void refresh(true)}>
              Weitere Geräte laden
            </Button>
          </Show>
          <InlineGuidance role="status" loading={loading()}>
            {loading() ? "Geräte werden geprüft …" : ""}
          </InlineGuidance>
        </section>
        <section class="kiosk-qr-side" aria-label="Kopplung">
          <Show when={paired()}>
            {(device) => (
              <>
                <h2>Laden-iPad gekoppelt</h2>
                <p>{device().name}</p>
                <Button variant="danger" disabled={busy() || denied()} onClick={() => void revoke(device().id)}>
                  Widerrufen
                </Button>
              </>
            )}
          </Show>
          <Show when={code()}>
            {(value) => (
              <Show
                when={value().expiresAt > now()}
                fallback={
                  <>
                    <h2>Der QR ist abgelaufen.</h2>
                    <p class="kiosk-muted">Fordern Sie einen neuen QR an.</p>
                    <Button disabled={busy() || denied()} onClick={newQr}>
                      {value().kind === "visit" ? "Neuen Besuchs-QR zeigen" : "Neuen Kopplungs-QR zeigen"}
                    </Button>
                  </>
                }
              >
                <h2>{value().kind === "visit" ? "Besuch am iPad öffnen" : "Mit dem iPad scannen"}</h2>
                <img class="kiosk-qr" src={value().image} alt={value().kind === "visit" ? "Besuchs-QR" : "Kopplungs-QR"} />
                <p class="kiosk-muted">Bis zu 2 Minuten gültig · einmal verwendbar</p>
                <p>Kein Code und kein Handy nötig.</p>
              </Show>
            )}
          </Show>
          <Show when={!code() && !paired()}>
            <p class="kiosk-muted">Nach dem Scan erscheinen hier der Gerätename und die Bestätigung.</p>
          </Show>
        </section>
      </div>
      <Show when={error()}>
        <InlineGuidance tone="danger" role="alert">
          {error()}{" "}
          <Button variant="text" disabled={busy() || denied()} onClick={() => void refresh()}>
            Status erneut prüfen
          </Button>
        </InlineGuidance>
      </Show>
      <Show when={denied()}>
        <Button onClick={() => location.reload()}>Zugang erneut prüfen</Button>
      </Show>
      <Show when={expiredRequest()}>
        {(request) => (
          <Button
            disabled={busy() || denied()}
            onClick={() => {
              const id = request().deviceId;
              if (request().kind === "visit" && id) void visit(id);
              else void pair();
            }}
          >
            {request().kind === "visit" ? "Neuen Besuchs-QR zeigen" : "Neuen Kopplungs-QR zeigen"}
          </Button>
        )}
      </Show>
      <Show when={retry()}>
        <Button disabled={busy() || denied()} onClick={() => void retryAction()}>
          Dieselbe Anfrage wiederholen
        </Button>
      </Show>
    </Paper>
  );
}
