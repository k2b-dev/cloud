import { timing } from "@k2b/stdlib";
import { Button, Checkbox, IconButton, LocaleProvider, PanelDialog, PinInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { openDialog } from "./dialog";
import { authMessages } from "./i18n";
import type { Preferences } from "./preferences";
import type { Vault } from "./vault";

export function Security(props: { vault: Vault; mode: "unlock" | "reset"; close: (ok?: boolean) => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [pin, setPin] = createSignal("");
  const [success, setSuccess] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [confirmed, setConfirmed] = createSignal(false);
  let pinControl: HTMLDivElement | undefined;
  let stopped = false;
  onCleanup(() => {
    stopped = true;
    props.vault.cancelPending();
    setPin("");
  });
  const valid = () => /^[0-9]{6}$/.test(pin());
  const run = async (operation: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch {
      if (!stopped) {
        setError(props.mode === "unlock" ? t().pinUnlockFailed : t().resetFailed);
      }
    } finally {
      const hadPinFocus = pinControl?.contains(document.activeElement);
      setPin("");
      if (!stopped) {
        setBusy(false);
        if (hadPinFocus) pinControl?.querySelector<HTMLInputElement>("input")?.focus();
      }
    }
  };
  const unlock = async () => {
    await props.vault.unlock(pin());
    if (stopped) return;
    setSuccess(true);
    await timing.sleep(600);
    if (!stopped && props.vault.status() === "open") props.close(true);
  };
  const submitPin = () => {
    if (!busy() && valid() && props.vault.retryAfter() === 0) void run(unlock);
  };
  onMount(() => {
    if (props.mode === "reset") return;
    let frame = 0;
    const focusPin = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (
          stopped ||
          props.mode !== "unlock" ||
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
    <div class="auth-security" classList={{ "auth-security--success": success() }}>
      <PanelDialog>
        <PanelDialog.Header
          actions={
            <Show when={!success()}>
              <IconButton
                label={t().close}
                variant="ghost"
                tooltip={false}
                disabled={props.mode !== "unlock" && busy()}
                onClick={() => props.close()}
              >
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            </Show>
          }
          title={success() ? t().pinRemoved : props.mode === "unlock" ? t().unlockApp : t().resetApp}
        />
        <PanelDialog.Body>
          <Show
            when={!success()}
            fallback={
              <div class="auth-unlock-success" role="status" aria-label={t().pinRemoved}>
                <i class="ti ti-circle-check" aria-hidden="true" />
              </div>
            }
          >
            <div class="auth-flow">
              <p>{props.mode === "reset" ? t().resetWarning : t().lockedHelp}</p>
              <Show when={props.mode === "reset"}>
                <Checkbox label={t().resetConfirm} value={confirmed} onValueChange={setConfirmed} />
              </Show>
              <Show when={props.mode === "unlock"}>
                <div ref={pinControl}>
                  <PinInput
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
        <Show when={props.mode === "reset"}>
          <PanelDialog.Footer>
            <Button
              disabled={busy() || !confirmed()}
              onClick={() =>
                void run(async () => {
                  await props.vault.reset();
                  if (!stopped) props.close(true);
                })
              }
            >
              {t().resetApp}
            </Button>
          </PanelDialog.Footer>
        </Show>
      </PanelDialog>
    </div>
  );
}
export const openSecurity = (vault: Vault, preferences: Preferences, mode: "unlock" | "reset") =>
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
