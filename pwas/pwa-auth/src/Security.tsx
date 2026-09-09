import { timing } from "@k2b/stdlib";
import { Button, Checkbox, IconButton, LocaleProvider, PanelDialog, PinInput, TextInput, useLocale } from "@k2b/ui";
import { type AppVaultSession } from "@valentinkolb/cloud/browser/app-approval";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { openDialog } from "./dialog";
import { authMessages } from "./i18n";
import type { Preferences } from "./preferences";
import type { Vault } from "./vault";

export function Security(props: { vault: Vault; mode: "setup" | "unlock" | "manage" | "reset"; close: (ok?: boolean) => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [pin, setPin] = createSignal("");
  const [repeat, setRepeat] = createSignal("");
  const [success, setSuccess] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [verified, setVerified] = createSignal(false);
  const [confirmed, setConfirmed] = createSignal(false);
  let proof: AppVaultSession | undefined;
  let pinControl: HTMLDivElement | undefined;
  let stopped = false;
  onCleanup(() => {
    stopped = true;
    props.vault.cancelPending();
    proof?.lock();
    setPin("");
    setRepeat("");
  });
  const authenticate = () => props.mode === "unlock" || (props.mode === "manage" && !verified());
  const pinEntry = () => props.mode !== "reset";
  const valid = () => /^[0-9]{6}$/.test(pin()) && (authenticate() || pin() === repeat());
  const run = async (operation: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch {
      if (!stopped) {
        proof?.lock();
        proof = undefined;
        setError(authenticate() ? t().pinUnlockFailed : t().securityFailed);
        setVerified(false);
      }
    } finally {
      const hadPinFocus = pinControl?.contains(document.activeElement);
      setPin("");
      setRepeat("");
      if (!stopped) {
        setBusy(false);
        if (hadPinFocus) pinControl?.querySelector<HTMLInputElement>("input")?.focus();
      }
    }
  };
  const perform = async () => {
    if (props.mode === "setup") await props.vault.setup(pin());
    else if (proof) {
      const value = proof;
      proof = undefined;
      await props.vault.change(value, pin());
    } else return;
    if (!stopped) props.close(true);
  };
  const unlock = async () => {
    if (props.mode === "unlock") {
      await props.vault.unlock(pin());
      if (stopped) return;
      setSuccess(true);
      await timing.sleep(600);
      if (!stopped && props.vault.status() === "open") props.close(true);
    } else {
      proof = await props.vault.verify(pin());
      if (stopped) {
        proof.lock();
        return;
      }
      setVerified(true);
    }
  };
  const submitPin = () => {
    if (!busy() && valid() && (!authenticate() || props.vault.retryAfter() === 0)) void run(authenticate() ? unlock : perform);
  };
  onMount(() => {
    if (props.mode === "reset") return;
    let frame = 0;
    const focusPin = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (
          stopped ||
          !pinEntry() ||
          busy() ||
          document.visibilityState !== "visible" ||
          !pinControl?.getClientRects().length ||
          pinControl.closest("dialog")?.open !== true
        )
          return;
        // Reload/window activation may restore focus after the dialog's initial focus pass.
        // Keep the user's current digit when the PIN already has focus.
        const active = document.activeElement;
        if (active && pinControl.contains(active)) return;
        pinControl.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
      });
    };
    focusPin();
    window.addEventListener("focus", focusPin);
    window.addEventListener("load", focusPin);
    window.addEventListener("pageshow", focusPin);
    document.addEventListener("visibilitychange", focusPin);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("focus", focusPin);
      window.removeEventListener("load", focusPin);
      window.removeEventListener("pageshow", focusPin);
      document.removeEventListener("visibilitychange", focusPin);
    });
  });
  return (
    <div classList={{ "auth-security--success": success() }}>
      <PanelDialog>
        <PanelDialog.Header
          actions={
            <Show when={props.mode === "unlock" && !success()}>
              <IconButton label={t().close} variant="ghost" tooltip={false} onClick={() => props.close()}>
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </Show>
          }
          title={
            success()
              ? t().unlocked
              : props.mode === "setup"
                ? t().pinSetupTitle
                : props.mode === "unlock"
                  ? t().unlockApp
                  : props.mode === "reset"
                    ? t().resetApp
                    : t().changePin
          }
        />
        <PanelDialog.Body>
          <Show
            when={!success()}
            fallback={
              <div class="auth-unlock-success" role="status" aria-label={t().unlocked}>
                <i class="ti ti-circle-check" aria-hidden="true" />
              </div>
            }
          >
            <div class="auth-flow">
              <Show when={props.mode !== "unlock"}>
                <p>
                  {props.mode === "reset" ? t().resetWarning : t().securityScope}
                  <Show when={props.mode === "manage" && authenticate()}> {t().verifyFirst}</Show>
                </p>
              </Show>
              <Show when={props.mode === "reset"}>
                <Checkbox label={t().resetConfirm} value={confirmed} onValueChange={setConfirmed} />
              </Show>

              <Show when={pinEntry()}>
                <Show
                  when={authenticate()}
                  fallback={
                    <TextInput
                      ref={(input) =>
                        queueMicrotask(() => {
                          if (input.isConnected && !stopped) input.focus();
                        })
                      }
                      label={t().appPin}
                      password
                      onSubmit={submitPin}
                      inputmode="numeric"
                      autocomplete="off"
                      maxLength={6}
                      value={pin}
                      onValueChange={(v) => setPin(v.replace(/[^0-9]/g, "").slice(0, 6))}
                      disabled={busy()}
                    />
                  }
                >
                  <div ref={pinControl}>
                    <PinInput
                      label={props.mode === "unlock" ? undefined : t().appPin}
                      aria-label={t().appPin}
                      length={6}
                      password
                      stretch
                      value={pin}
                      onValueChange={setPin}
                      onValueCommit={submitPin}
                      onSubmit={submitPin}
                      readOnly={busy() || props.vault.retryAfter() > 0}
                    />
                  </div>
                </Show>
                <Show when={!authenticate()}>
                  <TextInput
                    label={t().repeatPin}
                    password
                    onSubmit={submitPin}
                    inputmode="numeric"
                    autocomplete="off"
                    maxLength={6}
                    value={repeat}
                    onValueChange={(v) => setRepeat(v.replace(/[^0-9]/g, "").slice(0, 6))}
                    disabled={busy()}
                  />
                  <p>{t().pinWarning}</p>
                </Show>
              </Show>

              <Show when={error() || props.vault.retryAfter() > 0}>
                <div class="auth-security-feedback">
                  <Show when={error()}>
                    <p role="alert">{error()}</p>
                  </Show>
                  <Show when={props.vault.retryAfter() > 0}>
                    <span class="auth-security-countdown" role="status" aria-label={`${t().pinRetry} ${props.vault.retryAfter()} s`}>
                      {props.vault.retryAfter()} s
                    </span>
                  </Show>
                </div>
              </Show>
              <Show when={busy()}>
                <p role="status">{t().securing}</p>
              </Show>
            </div>
          </Show>
        </PanelDialog.Body>
        <Show when={props.mode !== "unlock"}>
          <PanelDialog.Footer>
            <div class="auth-dialog-actions">
              <Button variant="ghost" disabled={busy()} onClick={() => props.close()}>
                {t().close}
              </Button>

              <Show when={pinEntry() && !authenticate()}>
                <Button disabled={busy() || !valid()} onClick={submitPin}>
                  {t().saveSecurity}
                </Button>
              </Show>

              <Show when={props.mode === "reset"}>
                <Button
                  disabled={busy() || !confirmed()}
                  onClick={() =>
                    void run(async () => {
                      await props.vault.reset();
                      props.close(true);
                    })
                  }
                >
                  {t().resetApp}
                </Button>
              </Show>
            </div>
          </PanelDialog.Footer>
        </Show>
      </PanelDialog>
    </div>
  );
}
export const openSecurity = (vault: Vault, preferences: Preferences, mode: "setup" | "unlock" | "manage" | "reset") =>
  openDialog<boolean>(
    (close) => (
      <LocaleProvider locale={preferences.locale()}>
        <Security vault={vault} mode={mode} close={close} />
      </LocaleProvider>
    ),
    {
      panelClassName: "k2b-dialog k2b-dialog--small",
      contentClassName: "k2b-dialog__viewport",
      initialFocus:
        mode === "unlock"
          ? (dialog) => dialog.querySelector<HTMLElement>(".auth-flow input:not([disabled]), .auth-flow button:not([disabled])")
          : "first-input",
    },
  );
