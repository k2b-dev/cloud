import { Button, PanelDialog, TextInput, toast, useLocale } from "@k2b/ui";
import { appApproval } from "@k2b/cloud/browser/app-approval";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { type Authenticator, failure, type PairingPayload } from "./authenticator";
import { authMessages } from "./i18n";
import { QrCamera } from "./QrCamera";
import { bindingId, type Enrollment, storage } from "./storage";

export function Pairing(props: { auth: Authenticator; link?: string; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [text, setText] = createSignal("");
  const [scanning, setScanning] = createSignal(false);
  const [payload, setPayload] = createSignal<PairingPayload>();
  const [name, setName] = createSignal(t().defaultDeviceName);
  const [label, setLabel] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal("");
  const [comparison, setComparison] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  let enrollment: Enrollment | undefined;
  let deviceId: string | undefined;
  let abort = new AbortController();
  let stopped = false;
  let nextPoll = 0;
  let delay = appApproval.limits.pollSeconds * 1000;
  const parse = (link: string) => {
    setError("");
    try {
      const p = appApproval.parsePairingLink(link, location.origin);
      if (Date.parse(p.expiresAt) <= Date.now()) {
        setError(t().expiredLink);
        return false;
      }
      setText("");
      setPayload(p);
      return true;
    } catch {
      let message = t().invalidLink;
      try {
        const origin = new URL(link.trim()).origin;
        appApproval.parsePairingLink(link, origin);
        if (origin !== location.origin) message = t().wrongAppLink;
      } catch {
        /* Keep the generic format error for malformed links. */
      }
      setError(message);
      return false;
    }
  };
  const inspect = async () => {
    const p = payload();
    if (!p || !enrollment || stopped || busy() || document.visibilityState !== "visible" || !navigator.onLine || Date.now() < nextPoll)
      return;
    if (Date.parse(p.expiresAt) <= Date.now()) {
      stopped = true;
      setError(t().pairingExpired);
      return;
    }
    setBusy(true);
    setProgress(t().checkingPairing);
    let reserved = false;
    const pollId = `pair-poll:${enrollment.id}`;
    try {
      const saved = await storage.enrollment(enrollment.id);
      if (saved?.confirmed && saved.deviceId) {
        enrollment = saved;
        deviceId = saved.deviceId;
        setComparison(saved.comparison ?? "");
        setConfirmed(true);
        stopped = true;
        return;
      }
      reserved = await storage.reserve(pollId, Date.now() + appApproval.limits.pollSeconds * 1000);
      if (!reserved) return;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
      const api = await props.auth.client(p.issuer, signal);
      const result = await api.pairingResult(p, enrollment.key, signal);
      setError("");
      if (result.state === "cancelled") {
        stopped = true;
        setError(t().pairingExpired);
      }
      if (result.deviceId) {
        deviceId = result.deviceId;
        enrollment.deviceId = result.deviceId;
      }
      if (result.comparison) {
        setComparison(result.comparison);
        enrollment.comparison = result.comparison;
        await storage.saveEnrollment(enrollment);
      }
      if (result.state === "confirmed") {
        enrollment.confirmed = true;
        await storage.saveEnrollment(enrollment);
        setConfirmed(true);
        if (!comparison()) setError(t().pairingExpired);
        stopped = true;
      }
      delay = appApproval.limits.pollSeconds * 1000;
    } catch (e) {
      if (!abort.signal.aborted) {
        const reason = failure(e);
        setError(reason === "unavailable" ? t().pairingRetrying : t()[reason]);
        if (reason === "forbidden" || reason === "stale") stopped = true;
        delay = Math.min(delay * 2, appApproval.limits.proofSeconds * 1000);
      }
    } finally {
      nextPoll = Date.now() + delay;
      if (reserved) await storage.defer(pollId, nextPoll).catch(() => setError(t().storage));
      setBusy(false);
    }
  };
  const claim = async () => {
    const p = payload();
    if (!p || busy() || enrollment || !name().trim() || !label().trim()) return;
    setBusy(true);
    setError("");
    setProgress(t().connectingCloud);
    try {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
      const api = await props.auth.client(p.issuer, signal);
      const id = bindingId(p.issuer, p.pairingId);
      // Serializes generation and claim across tabs. Reload/paste recovers the original key.
      await navigator.locks.request(`pairing:${id}`, { signal }, async () => {
        const saved = await storage.enrollment(id);
        if (saved) {
          enrollment = saved;
          setName(saved.name);
          setLabel(saved.label);
          setComparison(saved.comparison ?? "");
          return;
        }
        setProgress(t().preparingPairing);
        const key = await storage.createKey();
        await storage.saveEnrollment({ id, issuer: p.issuer, key, name: name().trim(), label: label().trim() });
        enrollment = await storage.enrollment(id);
        if (!enrollment || !(enrollment.key.privateKey instanceof CryptoKey) || enrollment.key.privateKey.extractable)
          throw new Error("storage");
        signal.throwIfAborted();
        setProgress(t().sendingPairing);
        const claimed = await api.claim(p, enrollment.key, enrollment.name, signal);
        deviceId = claimed.deviceId;
        setComparison(claimed.comparison);
        enrollment.comparison = claimed.comparison;
        await storage.saveEnrollment(enrollment);
      });
    } catch (e) {
      if (!abort.signal.aborted) {
        const reason = failure(e);
        setError(reason === "unavailable" ? (enrollment ? t().pairingRetrying : t().pairingConnectionFailed) : t()[reason]);
      }
    } finally {
      setBusy(false);
      nextPoll = 0;
      void inspect();
    }
  };
  const finish = async () => {
    if (!confirmed() || !comparison() || !enrollment || !deviceId || busy()) return;
    setBusy(true);
    setProgress(t().savingCloud);
    try {
      await storage.saveBinding({
        id: bindingId(enrollment.issuer, deviceId),
        issuer: enrollment.issuer,
        deviceId,
        key: enrollment.key,
        label: enrollment.label,
        name: enrollment.name,
      });
      await storage.removeEnrollment(enrollment.id);
      setPayload(undefined);
      await props.auth.changed();
      props.close();
    } catch {
      setError(t().storage);
      setBusy(false);
    }
  };
  onMount(() => {
    if (props.link) parse(props.link);
    const timer = setInterval(() => {
      void inspect();
    }, 1000);
    const visibility = () => {
      if (document.visibilityState !== "visible") abort.abort();
      else {
        abort = new AbortController();
        void inspect();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    onCleanup(() => {
      clearInterval(timer);
      stopped = true;
      abort.abort();
      setPayload(undefined);
      document.removeEventListener("visibilitychange", visibility);
    });
  });
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().addCloud} />
      <PanelDialog.Body>
        <div class="auth-flow">
          <Show
            when={payload()}
            fallback={
              <>
                <Show when={!scanning()}>
                  <div class="auth-pairing-intro">
                    <i class="ti ti-cloud-plus" aria-hidden="true" />
                    <p>{t().pairingInstructions}</p>
                  </div>
                </Show>
                <Show
                  when={scanning()}
                  fallback={
                    <>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setError("");
                          setScanning(true);
                        }}
                      >
                        <i class="ti ti-qrcode" aria-hidden="true" />
                        {t().scanQr}
                      </Button>
                      <TextInput
                        icon="ti ti-link"
                        label={t().pairingLink}
                        value={text}
                        onValueChange={(value) => {
                          setText(value);
                          setError("");
                        }}
                        onSubmit={() => {
                          if (text().trim()) parse(text());
                        }}
                        maxLength={appApproval.limits.bodyBytes}
                        autocomplete="off"
                        spellcheck={false}
                      />
                    </>
                  }
                >
                  <QrCamera
                    onResult={(link) => {
                      if (!parse(link)) {
                        toast.error(error(), { title: t().invalidQrTitle });
                        return false;
                      }
                      setScanning(false);
                      return true;
                    }}
                    onStop={() => setScanning(false)}
                    onError={() => {
                      setScanning(false);
                      setError(t().cameraFailed);
                    }}
                  />
                </Show>
              </>
            }
          >
            {(p) => (
              <>
                <p>{t().trustIssuer}</p>
                <strong class="auth-issuer">{p().issuer}</strong>
                <Show when={!comparison() && !confirmed()}>
                  <TextInput
                    icon="ti ti-user"
                    label={t().accountLabel}
                    description={t().accountLabelHelp}
                    value={label}
                    onValueChange={setLabel}
                    maxLength={80}
                    disabled={busy() || !!enrollment}
                  />
                  <TextInput
                    icon="ti ti-device-mobile"
                    label={t().deviceName}
                    value={name}
                    onValueChange={setName}
                    maxLength={80}
                    disabled={busy() || !!enrollment}
                  />
                </Show>
                <Show when={comparison()}>
                  <p>{t().pairingComparison}</p>
                  <output class="auth-comparison">{comparison()}</output>
                  <p role="status">{confirmed() ? t().pairingConfirmed : t().waitingConfirmation}</p>
                </Show>

                <Show when={comparison()}>
                  <p class="auth-flow-note">{t().resumePairing}</p>
                </Show>
              </>
            )}
          </Show>
          <Show when={busy() && (!comparison() || !enrollment || confirmed())}>
            <p role="status">{progress()}</p>
          </Show>
          <Show when={!busy() && !!enrollment && !comparison() && !error()}>
            <p role="status">{t().checkingPairing}</p>
          </Show>
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="auth-dialog-actions">
          <Button variant="ghost" onClick={props.close}>
            {t().close}
          </Button>
          <Show when={scanning()}>
            <Button variant="secondary" onClick={() => setScanning(false)}>
              {t().stopCamera}
            </Button>
          </Show>
          <Show when={!payload() && !scanning()}>
            <Button disabled={!text().trim()} onClick={() => parse(text())}>
              {t().continuePairing}
            </Button>
          </Show>
          <Show when={payload() && !comparison() && !confirmed()}>
            <Button
              loading={busy()}
              loadingLabel={progress()}
              disabled={!!enrollment || !name().trim() || !label().trim()}
              onClick={() => {
                void claim();
              }}
            >
              {t().trustAndPair}
            </Button>
          </Show>
          <Show when={payload() && error() && !busy() && !confirmed()}>
            <Button
              variant="secondary"
              onClick={() => {
                abort.abort();
                abort = new AbortController();
                enrollment = undefined;
                deviceId = undefined;
                stopped = false;
                nextPoll = 0;
                delay = appApproval.limits.pollSeconds * 1000;
                setPayload(undefined);
                setComparison("");
                setError("");
              }}
            >
              {t().useAnotherLink}
            </Button>
          </Show>
          <Show when={comparison()}>
            <Button
              loading={confirmed() && busy()}
              loadingLabel={t().savingCloud}
              disabled={!confirmed() || busy()}
              onClick={() => {
                void finish();
              }}
            >
              {t().codesMatch}
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
