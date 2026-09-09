import { Button, Checkbox, IconButton, LocaleProvider, PanelDialog, Paper, TextInput, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Authenticator, Login } from "./authenticator";
import { openDialog } from "./dialog";
import { authMessages } from "./i18n";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";

function Decision(props: { auth: Authenticator; binding: Binding; request: Login; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [matched, setMatched] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(false);
  const expired = () => props.auth.now() >= Date.parse(props.request.expiresAt);
  const decide = async (decision: "approve" | "deny") => {
    if (busy() || error() || expired() || (decision === "approve" && !matched())) return;
    setBusy(true);
    try {
      await props.auth.decide(props.binding, props.request, decision);
      props.close();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().loginRequest} />
      <PanelDialog.Body>
        <div class="auth-flow">
          <strong>{props.binding.label}</strong>
          <span class="auth-issuer">{props.binding.issuer}</span>
          <p>{t().loginComparison}</p>
          <output class="auth-comparison">{props.request.comparison}</output>
          <Checkbox label={t().requestedAndMatched} value={matched} onValueChange={setMatched} />
          <Show when={expired()}>
            <p role="status">{t().requestExpired}</p>
          </Show>
          <Show when={error()}>
            <p role="alert">{t().uncertain}</p>
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button
          disabled={!matched() || busy() || error() || expired() || !props.auth.online()}
          onClick={() => {
            void decide("approve");
          }}
        >
          {t().approve}
        </Button>
        <Button
          variant="secondary"
          disabled={busy() || error() || expired() || !props.auth.online()}
          onClick={() => {
            void decide("deny");
          }}
        >
          {t().deny}
        </Button>
        <Button variant="ghost" onClick={props.close}>
          {t().close}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
function Disconnect(props: { auth: Authenticator; binding: Binding; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [forget, setForget] = createSignal(false);
  const run = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      if (forget()) await props.auth.forget(props.binding);
      else await props.auth.revoke(props.binding);
      props.close();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().disconnect} />
      <PanelDialog.Body>
        <div class="auth-flow">
          <strong>{props.binding.label}</strong>
          <span class="auth-issuer">{props.binding.issuer}</span>
          <p>{t().revokeExplanation}</p>
          <Show when={error()}>
            <p role="alert">{t().revokeUncertain}</p>
          </Show>
          <Checkbox label={t().forgetOnly} description={t().forgetWarning} value={forget} onValueChange={setForget} />
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button
          disabled={busy() || (!forget() && (error() || !props.auth.online()))}
          onClick={() => {
            void run();
          }}
        >
          {forget() ? t().forget : t().revoke}
        </Button>
        <Button variant="ghost" onClick={props.close}>
          {t().close}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
export function Clouds(props: { auth: Authenticator; preferences: Preferences }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const open = (binding: Binding, request: Login) =>
    openDialog(
      (close) => (
        <LocaleProvider locale={props.preferences.locale()}>
          <Decision auth={props.auth} binding={binding} request={request} close={() => close()} />
        </LocaleProvider>
      ),
      { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
    );
  return (
    <div class="auth-clouds">
      <For each={props.auth.bindings()}>
        {(binding) => {
          const [logoLoaded, setLogoLoaded] = createSignal(false);
          const [logoFailed, setLogoFailed] = createSignal(false);
          const state = () => props.auth.states()[binding.id];
          const requests = () => (state()?.requests ?? []).filter((r) => Date.parse(r.expiresAt) > props.auth.now());
          return (
            <Paper as="section" class="auth-cloud">
              <header>
                <span class="auth-cloud-logo" aria-hidden="true">
                  <Show when={!logoLoaded()}>
                    <i class="ti ti-cloud" />
                  </Show>
                  <Show when={!logoFailed()}>
                    <img
                      src={`${binding.issuer}/branding/logo`}
                      alt=""
                      width="40"
                      height="40"
                      referrerPolicy="no-referrer"
                      classList={{ "auth-cloud-logo--loaded": logoLoaded() }}
                      onLoad={() => setLogoLoaded(true)}
                      onError={() => {
                        setLogoLoaded(false);
                        setLogoFailed(true);
                      }}
                    />
                  </Show>
                </span>
                <div class="auth-cloud-heading">
                  <h2>{binding.label}</h2>
                  <p class="auth-issuer">{binding.issuer}</p>
                </div>
              </header>
              <Show when={state()?.error}>{(error) => <p role="status">{t()[error()]}</p>}</Show>
              <Show when={state() && !state()?.error && requests().length === 0}>
                <p class="auth-quiet">{t().noRequests}</p>
              </Show>
              <Show when={!state()}>
                <p class="auth-quiet">{t().checking}</p>
              </Show>
              <For each={requests()}>
                {(request) => (
                  <Button
                    variant="secondary"
                    class="auth-request"
                    onClick={() => {
                      void open(binding, request);
                    }}
                  >
                    <span>{t().loginRequest}</span>
                    <strong>{request.comparison}</strong>
                  </Button>
                )}
              </For>
            </Paper>
          );
        }}
      </For>
      <p class="auth-recovery">{t().recoveryHelp}</p>
    </div>
  );
}

function EditLabel(props: { auth: Authenticator; binding: Binding; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [label, setLabel] = createSignal(props.binding.label);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(false);
  const save = async () => {
    if (busy() || !label().trim()) return;
    setBusy(true);
    setError(false);
    try {
      await props.auth.rename(props.binding, label().trim());
      props.close();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().editCloudLabel} />
      <PanelDialog.Body>
        <div class="auth-flow">
          <TextInput
            label={t().accountLabel}
            value={label}
            onValueChange={setLabel}
            maxLength={80}
            disabled={busy()}
            onSubmit={() => void save()}
          />
          <Show when={error()}>
            <p role="alert">{t().storage}</p>
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div class="auth-dialog-actions">
          <Button variant="ghost" onClick={props.close}>
            {t().close}
          </Button>
          <Button loading={busy()} disabled={!label().trim()} onClick={() => void save()}>
            {t().saveLabel}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
export function openManageAccounts(auth: Authenticator, preferences: Preferences) {
  return openDialog(
    (close) => (
      <LocaleProvider locale={preferences.locale()}>
        <ManageAccounts auth={auth} preferences={preferences} close={() => close()} />
      </LocaleProvider>
    ),
    { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
  );
}
function ManageAccounts(props: { auth: Authenticator; preferences: Preferences; close: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const edit = (binding: Binding, remove: boolean) =>
    openDialog(
      (close) => (
        <LocaleProvider locale={props.preferences.locale()}>
          <Show when={remove} fallback={<EditLabel auth={props.auth} binding={binding} close={() => close()} />}>
            <Disconnect auth={props.auth} binding={binding} close={() => close()} />
          </Show>
        </LocaleProvider>
      ),
      { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
    );
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().manageAccounts} />
      <PanelDialog.Body>
        <div class="auth-flow">
          <For each={props.auth.bindings()} fallback={<p>{t().emptyTitle}</p>}>
            {(binding) => (
              <div class="auth-account-row">
                <div class="auth-account-copy">
                  <strong>{binding.label}</strong>
                  <p class="auth-issuer">{binding.issuer}</p>
                </div>
                <IconButton label={`${t().editCloudLabel}: ${binding.label}`} variant="ghost" onClick={() => void edit(binding, false)}>
                  <i class="ti ti-pencil" aria-hidden="true" />
                </IconButton>
                <IconButton label={`${t().disconnect}: ${binding.label}`} variant="ghost" onClick={() => void edit(binding, true)}>
                  <i class="ti ti-trash" aria-hidden="true" />
                </IconButton>
              </div>
            )}
          </For>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="ghost" onClick={props.close}>
          {t().close}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
