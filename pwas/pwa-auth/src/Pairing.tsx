import { Button, Checkbox, PanelDialog, TextInput, toast, useLocale } from "@k2b/ui";
import { appApproval } from "@valentinkolb/cloud/browser/app-approval";
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
  const [comparison, setComparison] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  const [matched, setMatched] = createSignal(false);
  let enrollment: Enrollment | undefined;
  let deviceId: string | undefined;
  let abort = new AbortController();
  let stopped = false;
  let nextPoll = 0;
  let delay = appApproval.limits.pollSeconds * 1000;
  const parse = (link: string) => {
    setText("");
    setError("");
    try {
      const p = appApproval.parsePairingLink(link, location.origin);
      if (Date.parse(p.expiresAt) <= Date.now()) throw new Error();
      setPayload(p);
      return true;
    } catch {
      setError(t().invalidLink);
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
      reserved = await storage.reserve(pollId, Date.now() + 2 * appApproval.limits.proofSeconds * 1000);
      if (!reserved) return;
      const api = await props.auth.client(p.issuer, abort.signal);
      const result = await api.pairingResult(p, enrollment.key, abort.signal);
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
        setError(t()[reason]);
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
    try {
      const api = await props.auth.client(p.issuer, abort.signal);
      const id = bindingId(p.issuer, p.pairingId);
      // Serializes generation and claim across tabs. Reload/paste recovers the original key.
      await navigator.locks.request(`pairing:${id}`, { signal: abort.signal }, async () => {
        const saved = await storage.enrollment(id);
        if (saved) {
          enrollment = saved;
          setName(saved.name);
          setLabel(saved.label);
          setComparison(saved.comparison ?? "");
          return;
        }
        const key = await appApproval.createKey();
        await storage.saveEnrollment({ id, issuer: p.issuer, key, name: name().trim(), label: label().trim() });
        enrollment = await storage.enrollment(id);
        if (!enrollment || !(enrollment.key.privateKey instanceof CryptoKey) || enrollment.key.privateKey.extractable)
          throw new Error("storage");
        const claimed = await api.claim(p, enrollment.key, enrollment.name, abort.signal);
        deviceId = claimed.deviceId;
        setComparison(claimed.comparison);
        enrollment.comparison = claimed.comparison;
        await storage.saveEnrollment(enrollment);
      });
    } catch (e) {
      setError(e instanceof Error && e.message === "storage" ? t().storage : t()[failure(e)]);
    } finally {
      setBusy(false);
      nextPoll = 0;
      void inspect();
    }
  };
  const finish = async () => {
    if (!confirmed() || !matched() || !enrollment || !deviceId || busy()) return;
    setBusy(true);
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
                        onValueChange={setText}
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
                        toast.error(t().invalidLink, { title: t().invalidQrTitle });
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
                  <Checkbox label={t().codesMatch} value={matched} onValueChange={setMatched} />
                  <p role="status">{confirmed() ? t().pairingConfirmed : t().waitingConfirmation}</p>
                </Show>

                <Show when={comparison()}>
                  <p class="auth-flow-note">{t().resumePairing}</p>
                </Show>
              </>
            )}
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
              disabled={busy() || !!enrollment || !name().trim() || !label().trim()}
              onClick={() => {
                void claim();
              }}
            >
              {t().trustAndPair}
            </Button>
          </Show>
          <Show when={confirmed()}>
            <Button
              disabled={!matched() || busy()}
              onClick={() => {
                void finish();
              }}
            >
              {t().finishPairing}
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
