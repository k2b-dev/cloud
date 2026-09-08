import { timing } from "@k2b/stdlib";
import { Button, Checkbox, IconButton, LocaleProvider, PanelDialog, PinInput, TextInput, useLocale } from "@k2b/ui";
import type { AppVaultSession } from "@valentinkolb/cloud/browser/app-approval";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
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
  const [selected, setSelected] = createSignal<"pin" | "passkey" | "remove-pin" | "remove-passkey">();
  const [verified, setVerified] = createSignal(false);
  const [passkeySelected, setPasskeySelected] = createSignal(false);
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
  const has = (type: "pin" | "passkey") => props.vault.header()?.config.methods.some((m) => m.type === type) ?? false;
  const authenticate = () => props.mode === "unlock" || (props.mode === "manage" && !!selected() && !verified());
  const passkeyEntry = () => authenticate() && has("passkey") && (!has("pin") || passkeySelected());
  const pinEntry = () => (authenticate() ? has("pin") && !passkeyEntry() : selected() === "pin");
  const valid = () => /^[0-9]{6}$/.test(pin()) && (authenticate() || pin() === repeat());
  const run = async (operation: () => Promise<void>) => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch {
      if (!stopped) {
        setVerified(false);
        if (props.mode === "setup" && selected() === "passkey") setSelected(undefined);
        setError(props.mode === "unlock" ? (pinEntry() ? t().pinUnlockFailed : t().passkeyUnlockFailed) : t().securityFailed);
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
    const action = selected();
    if (!action) return;
    if (props.mode === "setup" && (action === "pin" || action === "passkey")) await props.vault.setup(action, pin());
    else if (proof) {
      const value = proof;
      proof = undefined;
      await props.vault.change(value, action, pin());
    } else return;
    if (!stopped) props.close(true);
  };
  const unlock = async (type: "pin" | "passkey") => {
    if (props.mode === "unlock") {
      await props.vault.unlock(type, pin());
      if (stopped) return;
      setSuccess(true);
      await timing.sleep(600);
      if (!stopped && props.vault.status() === "open") props.close(true);
    } else {
      proof = await props.vault.verify(type, pin());
      if (stopped) {
        proof.lock();
        return;
      }
      setVerified(true);
    }
  };
  const submitPin = () => {
    if (!busy() && valid() && (!authenticate() || props.vault.retryAfter() === 0)) void run(authenticate() ? () => unlock("pin") : perform);
  };
  const choose = (action: "pin" | "passkey" | "remove-pin" | "remove-passkey") => {
    setSelected(action);
    setError("");
    if (props.mode === "setup" && action === "passkey") void run(perform);
  };
  const backToMethods = () => {
    setPin("");
    setRepeat("");
    setError("");
    setSelected(undefined);
  };
  const pinSetup = () => props.mode === "setup" && selected() === "pin";
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
                ? pinSetup()
                  ? t().pinSetupTitle
                  : t().protectApp
                : props.mode === "unlock"
                  ? t().unlockApp
                  : props.mode === "reset"
                    ? t().resetApp
                    : t().security
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
              <Show when={(props.mode === "setup" || props.mode === "manage") && !selected()}>
                <Show when={props.vault.capability() !== "unsupported"}>
                  <Button variant="secondary" disabled={busy()} onClick={() => choose("passkey")}>
                    {t().usePasskey}
                  </Button>
                  <p class="auth-flow-note">{props.vault.capability() === "supported" ? t().passkeyHelp : t().passkeyCheck}</p>
                </Show>
                <Button variant="secondary" disabled={busy()} onClick={() => choose("pin")}>
                  {has("pin") ? t().changePin : t().usePin}
                </Button>
                <Show when={props.mode === "manage" && has("pin") && has("passkey")}>
                  <Button variant="ghost" onClick={() => choose("remove-pin")}>
                    {t().removePin}
                  </Button>
                  <Button variant="ghost" onClick={() => choose("remove-passkey")}>
                    {t().removePasskey}
                  </Button>
                </Show>
              </Show>
              <Show when={authenticate()}>
                <Show when={passkeyEntry()}>
                  <Button disabled={busy()} onClick={() => void run(() => unlock("passkey"))}>
                    {t().unlockPasskey}
                  </Button>
                </Show>
              </Show>
              <Show when={pinEntry()}>
                <Show when={!authenticate()}>
                  <p class="auth-flow-note">{t().pinWarning}</p>
                </Show>
                <Show
                  when={authenticate()}
                  fallback={
                    <TextInput
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
                </Show>
              </Show>
              <Show when={authenticate() && has("pin") && has("passkey")}>
                <Button
                  variant="ghost"
                  disabled={busy()}
                  onClick={() => {
                    setPin("");
                    setError("");
                    setPasskeySelected(!passkeySelected());
                  }}
                >
                  {passkeyEntry() ? t().switchToPin : t().switchToPasskey}
                </Button>
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
              <Button variant="ghost" disabled={busy()} onClick={() => (pinSetup() ? backToMethods() : props.close())}>
                {pinSetup() ? t().back : t().close}
              </Button>
              <Show when={pinEntry() && !authenticate()}>
                <Button disabled={busy() || !valid()} onClick={submitPin}>
                  {t().saveSecurity}
                </Button>
              </Show>
              <Show when={verified() && selected() !== "pin"}>
                <Button disabled={busy()} onClick={() => void run(perform)}>
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
