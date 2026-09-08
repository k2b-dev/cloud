import { Button, Checkbox, dialogCore, LocaleProvider, PanelDialog, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { Authenticator, Login } from "./authenticator";
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
  const open = (binding: Binding, request?: Login) =>
    dialogCore.open(
      (close) => (
        <LocaleProvider locale={props.preferences.locale()}>
          <Show when={request} fallback={<Disconnect auth={props.auth} binding={binding} close={() => close()} />}>
            {(r) => <Decision auth={props.auth} binding={binding} request={r()} close={() => close()} />}
          </Show>
        </LocaleProvider>
      ),
      { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
    );
  return (
    <div class="auth-clouds">
      <For each={props.auth.bindings()}>
        {(binding) => {
          const state = () => props.auth.states()[binding.id];
          const requests = () => (state()?.requests ?? []).filter((r) => Date.parse(r.expiresAt) > props.auth.now());
          return (
            <section class="auth-cloud">
              <header>
                <div>
                  <h2>{binding.label}</h2>
                  <p class="auth-issuer">{binding.issuer}</p>
                </div>
                <Button
                  variant="ghost"
                  aria-label={`${t().disconnect}: ${binding.label}`}
                  onClick={() => {
                    void open(binding);
                  }}
                >
                  <i class="ti ti-unlink" aria-hidden="true" />
                </Button>
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
            </section>
          );
        }}
      </For>
      <p class="auth-recovery">{t().recoveryHelp}</p>
    </div>
  );
}
