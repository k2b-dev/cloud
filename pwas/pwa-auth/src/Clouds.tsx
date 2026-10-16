import { dates } from "@k2b/stdlib";
import {
  BottomSheet,
  Button,
  bottomSheetAdaptiveOptions,
  Checkbox,
  IconButton,
  LocaleProvider,
  PanelDialog,
  Paper,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { ActionSheet } from "./ActionSheet";
import type { ActionView, Authenticator, Login } from "./authenticator";
import { openDetails } from "./Details";
import { openDialog } from "./dialog";
import { authMessages } from "./i18n";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";

function Decision(props: {
  auth: Authenticator;
  binding: Binding;
  request: Login;
  position: number;
  total: number;
  dismiss: () => void | Promise<void>;
  close: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(false);
  const expired = () => props.auth.now() >= Date.parse(props.request.expiresAt);
  const decide = async (decision: "approve" | "deny") => {
    if (busy() || error() || expired()) return;
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
  createEffect(() => {
    const pending = props.auth.states()[props.binding.id]?.requests.some((r) => r.requestId === props.request.requestId);
    if (!busy() && !error() && (!pending || expired())) props.close();
  });
  const ending = (): "uncertain" | "expired" | undefined => (error() ? "uncertain" : expired() ? "expired" : undefined);
  const endings = {
    uncertain: { icon: "ti ti-alert-triangle", title: () => t().actionUncertainTitle, text: () => t().loginUncertain },
    expired: { icon: "ti ti-clock", title: () => t().actionExpiredTitle, text: () => t().requestExpired },
  } as const;
  let done: HTMLButtonElement | undefined;
  // An ending replaces both choices with Done; focus moves there instead of staying on a disabled button.
  createEffect(() => {
    if (ending()) queueMicrotask(() => done?.focus());
  });
  const groups = () => props.request.comparison.match(/.{1,3}/g) ?? [props.request.comparison];
  const off = () => busy() || error() || expired() || !props.auth.online();
  const Ending = (ending: { kind: keyof typeof endings }) => (
    <>
      <span class="auth-action-result__icon">
        <i class={endings[ending.kind].icon} aria-hidden="true" />
      </span>
      <h3>{endings[ending.kind].title()}</h3>
      <p>{endings[ending.kind].text()}</p>
    </>
  );
  return (
    <BottomSheet onDismiss={props.dismiss}>
      <PanelDialog.Header title={props.binding.label} subtitle={props.total > 1 ? `${props.position} / ${props.total}` : undefined} />
      <PanelDialog.Body>
        {/* The request and its ending share one grid cell, sized from the first frame by the longest ending, so the
            dialog keeps its height when the ending replaces the request. */}
        <div class="auth-decision" data-ended={ending() ? "" : undefined}>
          <div class="auth-decision__request" aria-hidden={ending() ? true : undefined}>
            <p>{t().loginComparison}</p>
            <output class="auth-comparison" aria-label={groups().join(" ")}>
              <For each={groups()}>{(group) => <span>{group}</span>}</For>
            </output>
          </div>
          <div class="auth-action-result auth-decision__sizer" aria-hidden="true">
            <Ending kind="uncertain" />
          </div>
          <div class="auth-action-result" data-outcome={ending()} role={error() ? "alert" : "status"}>
            <Show when={ending()}>{(kind) => <Ending kind={kind()} />}</Show>
          </div>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        {/* The choices and Done share one place too, so the footer keeps its height. */}
        <div class="auth-decision-actions" data-ended={ending() ? "" : undefined}>
          <div class="auth-decision-actions__choices" inert={ending() ? true : undefined}>
            <Button size="lg" variant="secondary" disabled={off()} onClick={() => void decide("deny")}>
              {t().deny}
            </Button>
            <Button size="lg" disabled={off()} loading={busy()} onClick={() => void decide("approve")}>
              {t().approve}
            </Button>
          </div>
          <div class="auth-decision-actions__done" inert={ending() ? undefined : true}>
            <Button size="lg" ref={done} onClick={() => props.close()}>
              {t().done}
            </Button>
          </div>
        </div>
      </PanelDialog.Footer>
    </BottomSheet>
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
/** A tapped Action notification: the request and, from newer notifications, the Cloud that asked. */
export type ActionFocus = { actionId: string; cloud?: string };
export function Clouds(props: {
  auth: Authenticator;
  preferences: Preferences;
  focus?: () => string | undefined;
  focused?: () => void;
  focusAction?: () => ActionFocus | undefined;
  actionFocused?: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  const [sheetOpen, setSheetOpen] = createSignal(false);
  // The Action whose view is loading, and the last one that could not load, as `binding:action`.
  const [loadingAction, setLoadingAction] = createSignal<string>();
  const [failedAction, setFailedAction] = createSignal<string>();
  const seen = new Set<string>();
  const loads = new AbortController();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    loads.abort();
  });
  const pending = () =>
    props.auth
      .bindings()
      .flatMap((binding) =>
        (props.auth.states()[binding.id]?.requests ?? [])
          .filter((request) => Date.parse(request.expiresAt) > props.auth.now())
          .map((request) => ({ binding, request, key: `${binding.id}:${request.requestId}` })),
      )
      .sort((a, b) => a.request.createdAt.localeCompare(b.request.createdAt) || a.key.localeCompare(b.key));
  const open = async (binding: Binding, request: Login) => {
    if (disposed || sheetOpen() || document.visibilityState !== "visible" || document.querySelector("dialog[open]")) return;
    const queue = pending();
    const key = `${binding.id}:${request.requestId}`;
    seen.add(key);
    setSheetOpen(true);
    try {
      await openDialog((close, context) => {
        if (disposed || document.visibilityState !== "visible") {
          queueMicrotask(() => close());
          return null;
        }
        return (
          <LocaleProvider locale={props.preferences.locale()}>
            <Decision
              auth={props.auth}
              binding={binding}
              request={request}
              position={queue.findIndex((item) => item.key === key) + 1}
              total={queue.length}
              dismiss={context.requestDismiss}
              close={() => close()}
            />
          </LocaleProvider>
        );
      }, bottomSheetAdaptiveOptions);
    } finally {
      if (!disposed) setSheetOpen(false);
    }
  };
  const blocked = () => disposed || sheetOpen() || document.visibilityState !== "visible" || !!document.querySelector("dialog[open]");
  // The view loads before the sheet opens, so the sheet never grows after its first frame.
  const openAction = async (candidates: Binding[], actionId: string) => {
    if (blocked() || candidates.length === 0) return;
    setSheetOpen(true);
    try {
      let loaded: { binding: Binding; view: ActionView } | undefined;
      for (const binding of candidates) {
        const key = `${binding.id}:${actionId}`;
        setLoadingAction(key);
        try {
          loaded = { binding, view: await props.auth.action(binding, actionId, loads.signal) };
          if (failedAction() === key) setFailedAction(undefined);
          break;
        } catch {
          if (!disposed) setFailedAction(key);
        }
      }
      if (!disposed) setLoadingAction(undefined);
      if (!loaded || disposed || document.visibilityState !== "visible" || document.querySelector("dialog[open]")) return;
      const { binding, view } = loaded;
      await openDialog(
        (close, context) => (
          <LocaleProvider locale={props.preferences.locale()}>
            <ActionSheet auth={props.auth} binding={binding} view={view} dismiss={context.requestDismiss} close={() => close()} />
          </LocaleProvider>
        ),
        bottomSheetAdaptiveOptions,
      );
    } finally {
      if (!disposed) setSheetOpen(false);
    }
  };
  createEffect(() => {
    const queue = pending();
    const keys = new Set(queue.map((item) => item.key));
    for (const key of seen) if (!keys.has(key)) seen.delete(key);
    if (sheetOpen() || !props.auth.online()) return;
    // A tapped Action loads directly, also when the inbox omitted it; the account that listed it goes first.
    const focusAction = props.focusAction?.();
    if (focusAction && !blocked()) {
      const bindings = props.auth.bindings();
      const listed = bindings.filter((binding) =>
        props.auth.states()[binding.id]?.actions.some((action) => action.actionId === focusAction.actionId),
      );
      const candidates = [...listed, ...bindings.filter((binding) => binding.issuer === focusAction.cloud && !listed.includes(binding))];
      // Without a Cloud, wait until every account has listed its inbox once.
      if (candidates.length || (bindings.length > 0 && bindings.every((binding) => props.auth.states()[binding.id]))) {
        props.actionFocused?.();
        void openAction(candidates, focusAction.actionId);
        return;
      }
    }
    // A tapped notification reopens its request even after the sheet was dismissed.
    const focus = props.focus?.();
    const focused = focus ? queue.find((item) => item.request.requestId === focus) : undefined;
    if (focused) props.focused?.();
    const next = focused ?? queue.find((item) => !seen.has(item.key));
    if (next) void open(next.binding, next.request);
  });
  return (
    <div class="auth-clouds">
      <For each={props.auth.bindings()}>
        {(binding) => {
          const [logoLoaded, setLogoLoaded] = createSignal(false);
          const [logoFailed, setLogoFailed] = createSignal(false);
          const state = () => props.auth.states()[binding.id];
          const requests = () => (state()?.requests ?? []).filter((r) => Date.parse(r.expiresAt) > props.auth.now());
          const actions = () => (state()?.actions ?? []).filter((action) => Date.parse(action.expiresAt) > props.auth.now());
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
                  <p class="auth-issuer">{new URL(binding.issuer).host}</p>
                </div>
                <IconButton
                  class="auth-cloud-info"
                  label={t().cloudDetails({ cloud: binding.label })}
                  variant="ghost"
                  tooltip={false}
                  onClick={() => void openDetails(props.auth, binding, props.preferences)}
                >
                  <i class="ti ti-info-circle" aria-hidden="true" />
                </IconButton>
              </header>
              <Show when={state()?.error}>{(error) => <p role="status">{t()[error()]}</p>}</Show>
              <Show when={state() && !state()?.error && requests().length === 0 && actions().length === 0 && !state()?.moreActions}>
                <p class="auth-quiet">{t().noRequests}</p>
              </Show>
              <Show when={!state()}>
                <p class="auth-quiet">{t().checking}</p>
              </Show>
              <For each={requests()}>
                {(request) => (
                  <RequestRow
                    auth={props.auth}
                    binding={binding}
                    request={request}
                    open={() => {
                      void open(binding, request);
                    }}
                  />
                )}
              </For>
              <For each={actions()}>
                {(action) => {
                  const key = `${binding.id}:${action.actionId}`;
                  return (
                    <div class="auth-action-row">
                      <div class="auth-action-row__copy">
                        <p class="auth-action-row__title">
                          <strong>{action.app.name}</strong> · {action.sentence}
                        </p>
                        {/* A load failure takes the origin line's place, so the row keeps its height. */}
                        <Show
                          when={failedAction() !== key}
                          fallback={
                            <p class="auth-action-row__origin auth-action-row__origin--failed" role="alert">
                              <span>{t().actionLoadFailed}</span>
                            </p>
                          }
                        >
                          <p class="auth-action-row__origin">
                            {/* A long chat title gives way; the time always stays visible. */}
                            <Show when={action.requester.title}>
                              {(title) => (
                                <>
                                  <span>{t().actionChatTitle({ title: title() })}</span>
                                  <span aria-hidden="true"> · </span>
                                </>
                              )}
                            </Show>
                            <time dateTime={action.createdAt}>{dates.formatDateTimeRelative(action.createdAt, { locale: locale() })}</time>
                          </p>
                        </Show>
                      </div>
                      <Button
                        variant="secondary"
                        loading={loadingAction() === key}
                        onClick={() => void openAction([binding], action.actionId)}
                      >
                        {t().actionReview}
                      </Button>
                    </div>
                  );
                }}
              </For>
              <Show when={(state()?.moreActions ?? 0) > 0}>
                <p class="auth-quiet">{t().moreActions({ count: state()?.moreActions ?? 0 })}</p>
              </Show>
            </Paper>
          );
        }}
      </For>
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
  return openDialog<boolean>(
    (close) => (
      <LocaleProvider locale={preferences.locale()}>
        <ManageAccounts auth={auth} preferences={preferences} close={close} />
      </LocaleProvider>
    ),
    { panelClassName: "k2b-dialog k2b-dialog--small", contentClassName: "k2b-dialog__viewport" },
  );
}
function ManageAccounts(props: { auth: Authenticator; preferences: Preferences; close: (add?: boolean) => void }) {
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
                  <p class="auth-issuer">{new URL(binding.issuer).host}</p>
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
        <div class="auth-dialog-actions">
          <Button variant="ghost" onClick={() => props.close()}>
            {t().close}
          </Button>
          <Button onClick={() => props.close(true)}>{t().addCloud}</Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

function RequestRow(props: { auth: Authenticator; binding: Binding; request: Login; open: () => void }) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  return (
    <div class="auth-request auth-request-row">
      <span>{t().loginRequest}</span>
      <div class="auth-request-actions">
        <Button variant="secondary" onClick={props.open}>
          {t().signIn}
        </Button>
      </div>
    </div>
  );
}
