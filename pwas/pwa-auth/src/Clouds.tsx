import { dates } from "@k2b/stdlib";
import {
  BottomSheet,
  Button,
  bottomSheetAdaptiveOptions,
  Checkbox,
  IconButton,
  LocaleProvider,
  NoticeCard,
  PanelDialog,
  Paper,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { ActionSheet } from "./ActionSheet";
import type { ActionView, Authenticator, Login } from "./authenticator";
import { openDetails } from "./Details";
import { openDialog } from "./dialog";
import { authMessages, scopeLabel } from "./i18n";
import type { Preferences } from "./preferences";
import type { Binding } from "./storage";

type LoginContext = NonNullable<Login["context"]>;
const BROWSERS = {
  firefox: { name: "Firefox", icon: "ti ti-brand-firefox" },
  chrome: { name: "Chrome", icon: "ti ti-brand-chrome" },
  safari: { name: "Safari", icon: "ti ti-brand-safari" },
  edge: { name: "Edge", icon: "ti ti-brand-edge" },
  samsung: { name: "Samsung Internet", icon: "ti ti-world" },
  opera: { name: "Opera", icon: "ti ti-brand-opera" },
  other: { name: undefined, icon: "ti ti-world" },
} as const satisfies Record<LoginContext["browser"], { name: string | undefined; icon: string }>;
const SYSTEMS = {
  windows: "Windows",
  macos: "macOS",
  "mac-or-ipad": undefined,
  ios: "iOS",
  android: "Android",
  linux: "Linux",
  chromeos: "ChromeOS",
  other: undefined,
} as const satisfies Record<LoginContext["os"], string | undefined>;
type Row = { label?: string; icon?: string; values: string[]; time?: string };

function Decision(props: {
  auth: Authenticator;
  binding: Binding;
  request: Login;
  position: number;
  total: number;
  dialog: HTMLDialogElement;
  dismiss: () => void | Promise<void>;
  close: () => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => authMessages.resolve([locale()]).t);
  // The request as the dialog opened with it; later polls never add or remove a line. A terminal sign-in
  // never carries context, and its sheet stays as it is even if a Cloud sent some.
  const context = props.request.terminal ? undefined : props.request.context;
  const level = context?.level;
  const [busy, setBusy] = createSignal<"approve" | "deny">();
  const [error, setError] = createSignal(false);
  const [denied, setDenied] = createSignal(false);
  const expired = () => props.auth.now() >= Date.parse(props.request.expiresAt);
  const decide = async (decision: "approve" | "deny") => {
    if (busy() || error() || denied() || expired()) return;
    setBusy(decision);
    try {
      await props.auth.decide(props.binding, props.request, decision);
      // After a warning, the denial stays in place so the person sees that nobody was signed in.
      if (decision === "deny" && level === "warn") setDenied(true);
      else props.close();
    } catch {
      setError(true);
    } finally {
      setBusy(undefined);
    }
  };
  createEffect(() => {
    const pending = props.auth.states()[props.binding.id]?.requests.some((r) => r.requestId === props.request.requestId);
    // An expired request stays open with its ending, so the code never vanishes without a word.
    if (!busy() && !error() && !denied() && !expired() && !pending) props.close();
  });
  // A memo, so effects run when the ending changes, not on every clock tick.
  const ending = createMemo((): "uncertain" | "denied" | "expired" | undefined =>
    error() ? "uncertain" : denied() ? "denied" : expired() ? "expired" : undefined,
  );
  const terminal = () => props.request.terminal;
  const endings = {
    uncertain: {
      icon: "ti ti-alert-triangle",
      title: () => t().actionUncertainTitle,
      text: () => (terminal() ? t().terminalUncertain : t().loginUncertain),
    },
    expired: {
      icon: "ti ti-clock",
      title: () => t().actionExpiredTitle,
      text: () => (terminal() ? t().terminalExpired : t().requestExpired),
    },
    denied: { icon: "ti ti-hand-stop", title: () => t().actionDenied, text: () => t().loginDenied },
  } as const;
  // The endings this request can reach; the place for them is as high as the longest.
  const reachable: (keyof typeof endings)[] = level === "warn" ? ["uncertain", "expired", "denied"] : ["uncertain", "expired"];
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The device's own clock face: the person compares it with when they started the sign-in.
  const started = () => dates.formatTime(props.request.createdAt, { locale: locale(), timeZone });
  const day = (value: string) => dates.formatDate(value, { locale: locale(), timeZone, style: "numeric" });
  const country = (code: string) => {
    try {
      return new Intl.DisplayNames([locale()], { type: "region" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  // Cloud Login's own words for what the Cloud reported, as label and value rows. A browser sign-in's rows
  // stand above the code and carry an icon instead of a label; a terminal's stand below it.
  const details = createMemo((): Row[] => {
    const login = terminal();
    if (login)
      return [
        { label: t().terminalCloud, values: [new URL(props.binding.issuer).host] },
        {
          label: t().terminalLifetime,
          values: [dates.formatDuration(new Date(0), new Date(login.lifetimeSeconds * 1000), { locale: locale() })],
        },
        // The longest row goes last, so a small screen shows the short rows before it scrolls.
        { label: t().terminalScopes, values: login.scopes.map((scope) => scopeLabel(scope, t())) },
      ];
    if (!context) return [];
    const browser = BROWSERS[context.browser];
    const name = browser.name ?? t().contextUnknownBrowser;
    const os = context.os === "mac-or-ipad" ? t().contextMacOrIpad : SYSTEMS[context.os];
    const rows: Row[] = [{ icon: browser.icon, values: [os ? t().contextBrowser({ browser: name, os }) : name] }];
    // Without a location database the Cloud knows neither place nor network, and both lines stay away.
    if (context.country !== null || context.city !== null || context.network !== null) {
      const place = [context.city, context.country && country(context.country)].filter(Boolean).join(", ");
      rows.push(
        { icon: "ti ti-map-pin", values: [place ? t().contextPlace({ place }) : t().contextPlaceUnknown] },
        {
          icon: "ti ti-network",
          values: [context.network ? t().contextNetwork({ network: context.network }) : t().contextNetworkUnknown],
        },
      );
    }
    if (context.sameNetwork) rows.push({ icon: "ti ti-device-mobile", values: [t().contextSameNetwork] });
    rows.push({ icon: "ti ti-clock", values: [t().loginStarted({ time: started() })], time: props.request.createdAt });
    const since = context.history?.knownSince;
    if (since) rows.push({ icon: "ti ti-history", values: [t().contextKnown({ date: day(since) })] });
    return rows;
  });
  // Only Core's level decides whether a note shows; the history only chooses its words.
  const note = createMemo(() => {
    const history = context?.history;
    const countriesSince = history?.countriesSince;
    if (level === "warn")
      return {
        tone: "warning" as const,
        title: t().contextWarnTitle,
        text: countriesSince ? t().contextWarnSince({ date: day(countriesSince) }) : t().contextWarn,
      };
    if (level !== "hint") return undefined;
    if (!history?.knownSince) return { tone: "info" as const, text: t().contextNewBrowser };
    return {
      tone: "info" as const,
      text: countriesSince ? t().contextNewCountrySince({ date: day(countriesSince) }) : t().contextNewCountry,
    };
  });
  const noteId = createUniqueId();
  // A screen reader reads the note with the dialog's name while the request is shown.
  createEffect(() => {
    if (note() && !ending()) props.dialog.setAttribute("aria-describedby", noteId);
    else props.dialog.removeAttribute("aria-describedby");
  });
  onCleanup(() => props.dialog.removeAttribute("aria-describedby"));
  let done: HTMLButtonElement | undefined;
  // An ending replaces both choices with Done; focus moves there instead of staying on a disabled button.
  createEffect(() => {
    if (ending()) queueMicrotask(() => done?.focus());
  });
  const groups = () => props.request.comparison.match(/.{1,3}/g) ?? [props.request.comparison];
  const offline = () => !props.auth.online();
  const off = () => !!busy() || error() || denied() || expired() || offline();
  const Ending = (ending: { kind: keyof typeof endings }) => (
    <>
      <span class="auth-action-result__icon">
        <i class={endings[ending.kind].icon} aria-hidden="true" />
      </span>
      <h3>{endings[ending.kind].title()}</h3>
      <p>{endings[ending.kind].text()}</p>
    </>
  );
  const Rows = () => (
    <dl class="auth-action-details auth-decision__details" data-context={terminal() ? undefined : ""}>
      <For each={details()}>
        {(row) => (
          <>
            <dt>
              <Show when={row.icon} fallback={row.label}>
                {(icon) => <i class={icon()} aria-hidden="true" />}
              </Show>
            </dt>
            <dd>
              <Show
                when={row.values.length > 1}
                fallback={
                  <Show when={row.time} fallback={row.values[0]}>
                    {(time) => <time dateTime={time()}>{row.values[0]}</time>}
                  </Show>
                }
              >
                <ul>
                  <For each={row.values}>{(value) => <li>{value}</li>}</For>
                </ul>
              </Show>
            </dd>
          </>
        )}
      </For>
    </dl>
  );
  return (
    <BottomSheet onDismiss={props.dismiss}>
      <Show
        when={terminal()}
        fallback={
          <PanelDialog.Header title={props.binding.label} subtitle={props.total > 1 ? `${props.position} / ${props.total}` : undefined} />
        }
      >
        {(login) => (
          <PanelDialog.Header
            title={t().terminalTitle({ client: login().client.name })}
            subtitle={props.total > 1 ? `${props.binding.label} · ${props.position} / ${props.total}` : props.binding.label}
          />
        )}
      </Show>
      <PanelDialog.Body>
        {/* The request and its ending share one grid cell, sized from the first frame by the longest ending, so the
            dialog keeps its height when the ending replaces the request. */}
        <div class="auth-decision" data-ended={ending() ? "" : undefined}>
          <div class="auth-decision__request" aria-hidden={ending() ? true : undefined}>
            <Show
              when={context}
              fallback={
                <p class="auth-decision__started">
                  <i class="ti ti-clock" aria-hidden="true" />
                  <time dateTime={props.request.createdAt}>{t().loginStarted({ time: started() })}</time>
                </p>
              }
            >
              <Rows />
            </Show>
            <Show when={note()}>
              {(note) => (
                <Show
                  when={note().title}
                  fallback={
                    <NoticeCard id={noteId} tone={note().tone}>
                      {note().text}
                    </NoticeCard>
                  }
                >
                  {(title) => <NoticeCard id={noteId} tone={note().tone} title={title()} detail={note().text} />}
                </Show>
              )}
            </Show>
            <Show when={!terminal()} fallback={<p>{t().terminalComparison}</p>}>
              {/* Offline, the reason takes the hint's place in the same cell; the code below does not move. */}
              <div class="auth-decision__hint" data-offline={offline() ? "" : undefined}>
                <p aria-hidden={offline() ? true : undefined}>{t().loginComparison}</p>
                <NoticeCard role="status" aria-hidden={offline() ? undefined : true}>
                  {t().loginOffline}
                </NoticeCard>
              </div>
            </Show>
            <output class="auth-comparison" aria-label={groups().join(" ")}>
              <For each={groups()}>{(group) => <span>{group}</span>}</For>
            </output>
            <Show when={terminal()}>
              <Rows />
            </Show>
          </div>
          <div class="auth-decision__sizer" aria-hidden="true">
            <For each={reachable}>
              {(kind) => (
                <div class="auth-action-result">
                  <Ending kind={kind} />
                </div>
              )}
            </For>
          </div>
          <div class="auth-action-result" data-outcome={ending()} role={error() ? "alert" : "status"}>
            <Show when={ending()}>{(kind) => <Ending kind={kind()} />}</Show>
          </div>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        {/* The choices and Done share one place too, so the footer keeps its height. After a warning, Deny becomes
            the main action and Approve its quieter alternative, each in its own place. */}
        <div class="auth-decision-actions" data-ended={ending() ? "" : undefined}>
          <div class="auth-decision-actions__choices" inert={ending() ? true : undefined}>
            <Button
              size="lg"
              variant={level === "warn" ? "primary" : "secondary"}
              disabled={off()}
              loading={busy() === "deny"}
              onClick={() => void decide("deny")}
            >
              {t().deny}
            </Button>
            <Button
              size="lg"
              variant={level === "warn" ? "secondary" : "primary"}
              disabled={off()}
              loading={busy() === "approve"}
              onClick={() => void decide("approve")}
            >
              {level === "warn" ? t().approveAnyway : t().approve}
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
              dialog={context.dialog}
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
      <span>{props.request.terminal ? t().terminalTitle({ client: props.request.terminal.client.name }) : t().loginRequest}</span>
      <div class="auth-request-actions">
        <Button variant="secondary" onClick={props.open}>
          {t().signIn}
        </Button>
      </div>
    </div>
  );
}
