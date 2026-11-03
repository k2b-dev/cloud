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
import { createEffect, createMemo, createSignal, createUniqueId, For, Match, onCleanup, Show, Switch } from "solid-js";
import { ActionSheet } from "./ActionSheet";
import type { ActionView, Authenticator, DeviceChange, Failure, Login } from "./authenticator";
import { ChangeSheet } from "./ChangeSheet";
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
// A browser sign-in's row shows its icon and keeps the label for screen readers.
type Row = { label: string; icon?: string; values: string[]; time?: string };
type Messages = ReturnType<typeof authMessages.resolve>["t"];
/** The browser that asks, as the sheet and the card name it. */
function browserOf(context: LoginContext, t: Messages) {
  const browser = BROWSERS[context.browser];
  const name = browser.name ?? t.contextUnknownBrowser;
  const os = context.os === "mac-or-ipad" ? t.contextMacOrIpad : SYSTEMS[context.os];
  return { icon: browser.icon, device: os ? t.contextBrowser({ browser: name, os }) : name };
}
/** One request waiting on a card: what it is, from where, and how to open its sheet. */
type Waiting = {
  key: string;
  at: string;
  title: string;
  from?: string;
  login?: boolean;
  warn?: boolean;
  actionId?: string;
  open: () => void;
};

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
    // Going offline or hidden clears the list without an answer, and the sheet then keeps the request with its
    // offline note. It closes once a poll answers without the request, when the Cloud refuses this phone (polling
    // stops for it), or when the binding is gone, for example after the vault locked.
    const state = props.auth.states()[props.binding.id];
    const gone =
      !props.auth.bindings().some((binding) => binding.id === props.binding.id) ||
      state?.error === "forbidden" ||
      (state && !state.error && !state.requests.some((r) => r.requestId === props.request.requestId));
    // An expired request stays open with its ending, so the code never vanishes without a word.
    if (!busy() && !error() && !denied() && !expired() && gone) props.close();
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
    const browser = browserOf(context, t());
    const rows: Row[] = [{ label: t().contextLabelBrowser, icon: browser.icon, values: [browser.device] }];
    // Without a location database the Cloud knows neither place nor network, and both lines stay away.
    if (context.country !== null || context.city !== null || context.network !== null) {
      const place = [context.city, context.country && country(context.country)].filter(Boolean).join(", ");
      rows.push(
        { label: t().contextLabelPlace, icon: "ti ti-map-pin", values: [place ? t().contextPlace({ place }) : t().contextPlaceUnknown] },
        {
          label: t().contextLabelNetwork,
          icon: "ti ti-network",
          values: [context.network ? t().contextNetwork({ network: context.network }) : t().contextNetworkUnknown],
        },
      );
    }
    if (context.sameNetwork) rows.push({ label: t().contextLabelAddress, icon: "ti ti-device-mobile", values: [t().contextSameNetwork] });
    rows.push({
      label: t().contextLabelStarted,
      icon: "ti ti-clock",
      values: [t().loginStarted({ time: started() })],
      time: props.request.createdAt,
    });
    const since = context.history?.knownSince;
    if (since) rows.push({ label: t().contextLabelHistory, icon: "ti ti-history", values: [t().contextKnown({ date: day(since) })] });
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
  const where = () => {
    const host = new URL(props.binding.issuer).host;
    return props.total > 1 ? `${host} · ${props.position} / ${props.total}` : host;
  };
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
                {(icon) => (
                  <>
                    <i class={icon()} aria-hidden="true" />
                    <span class="k2b-sr-only">{row.label}</span>
                  </>
                )}
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
      {/* The head always names the Cloud's address, so a request is never approved for the wrong Cloud. */}
      <Show when={terminal()} fallback={<PanelDialog.Header title={t().loginTitle({ cloud: props.binding.label })} subtitle={where()} />}>
        {(login) => (
          <PanelDialog.Header title={t().terminalTitle({ client: login().client.name })} subtitle={`${props.binding.label} · ${where()}`} />
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
  const changes = () =>
    props.auth
      .bindings()
      .flatMap((binding) =>
        (props.auth.states()[binding.id]?.changes ?? [])
          .filter((change) => Date.parse(change.expiresAt) > props.auth.now())
          .map((change) => ({ binding, change, key: `${binding.id}:${change.changeId}` })),
      )
      .sort((a, b) => a.change.createdAt.localeCompare(b.change.createdAt) || a.key.localeCompare(b.key));
  const openChange = async (binding: Binding, change: DeviceChange) => {
    if (disposed || sheetOpen() || document.visibilityState !== "visible" || document.querySelector("dialog[open]")) return;
    seen.add(`${binding.id}:${change.changeId}`);
    setSheetOpen(true);
    try {
      await openDialog((close, context) => {
        if (disposed || document.visibilityState !== "visible") {
          queueMicrotask(() => close());
          return null;
        }
        return (
          <LocaleProvider locale={props.preferences.locale()}>
            <ChangeSheet auth={props.auth} binding={binding} change={change} dismiss={context.requestDismiss} close={() => close()} />
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
    const changeQueue = changes();
    const keys = new Set([...queue, ...changeQueue].map((item) => item.key));
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
    // Device changes wake the phone like a sign-in does, with the change's id as the request.
    const focusedChange = focus && !focused ? changeQueue.find((item) => item.change.changeId === focus) : undefined;
    if (focused || focusedChange) props.focused?.();
    if (focusedChange) {
      void openChange(focusedChange.binding, focusedChange.change);
      return;
    }
    const next = focused ?? queue.find((item) => !seen.has(item.key));
    if (next) {
      void open(next.binding, next.request);
      return;
    }
    // Sign-ins wait in the browser and go first; a change request opens once none is left.
    const nextChange = changeQueue.find((item) => !seen.has(item.key));
    if (nextChange) void openChange(nextChange.binding, nextChange.change);
  });
  // The short words of a card's one line; the long explanation is in its accessible name and in Details.
  const problems = {
    unavailable: { icon: "ti ti-cloud-off", text: () => t().statusUnavailable, long: () => t().unavailable },
    // Polling stops for a refused device, so it offers no reload.
    forbidden: { icon: "ti ti-lock", text: () => t().statusForbidden, long: () => t().forbidden },
    stale: { icon: "ti ti-alert-circle", text: () => t().statusStale, long: () => t().stale },
    storage: { icon: "ti ti-alert-circle", text: () => t().statusStorage, long: () => t().storage },
    uncertain: { icon: "ti ti-alert-circle", text: () => t().statusStale, long: () => t().uncertain },
  } satisfies Record<Failure, { icon: string; text: () => string; long: () => string }>;
  // On the app's clock, so the line follows the tick and tests stay deterministic.
  const ago = (at: string) => {
    const minutes = Math.floor((props.auth.now() - Date.parse(at)) / 60_000);
    if (minutes < 1) return t().justNow;
    const format = new Intl.RelativeTimeFormat(locale(), { style: "short" });
    return minutes < 60 ? format.format(-minutes, "minute") : format.format(-Math.floor(minutes / 60), "hour");
  };
  return (
    <div class="auth-clouds">
      <For each={props.auth.bindings()}>
        {(binding) => {
          const [logoLoaded, setLogoLoaded] = createSignal(false);
          const [logoFailed, setLogoFailed] = createSignal(false);
          const [rechecking, setRechecking] = createSignal(false);
          const host = new URL(binding.issuer).host;
          const state = () => props.auth.states()[binding.id];
          const live = <T extends { expiresAt: string }>(items: T[] | undefined) =>
            (items ?? []).filter((item) => Date.parse(item.expiresAt) > props.auth.now());
          // Everything waiting on this Cloud, oldest first; a tap on the card opens the oldest.
          const waiting = createMemo((): Waiting[] =>
            [
              ...live(state()?.requests).map((request) => {
                const context = request.terminal ? undefined : request.context;
                return {
                  key: `${binding.id}:${request.requestId}`,
                  at: request.createdAt,
                  title: request.terminal
                    ? t().terminalTitle({ client: request.terminal.client.name })
                    : context?.level === "warn"
                      ? t().loginUnusual
                      : t().loginRequest,
                  from: context ? browserOf(context, t()).device : undefined,
                  login: true,
                  warn: context?.level === "warn",
                  open: () => void open(binding, request),
                };
              }),
              ...live(state()?.changes).map((change) => ({
                key: `${binding.id}:${change.changeId}`,
                at: change.createdAt,
                title: change.kind === "pair" ? t().changePairRow : t().changeRevokeRow,
                from: change.device.name || t().changeUnnamed,
                open: () => void openChange(binding, change),
              })),
              ...live(state()?.actions).map((action) => ({
                key: `${binding.id}:${action.actionId}`,
                at: action.createdAt,
                title: t().actionRequest,
                from: action.sentence,
                actionId: action.actionId,
                open: () => void openAction([binding], action.actionId),
              })),
            ].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key)),
          );
          // An Action that could not load waits behind the others; alone, it becomes the card's error line.
          const ready = () => waiting().filter((item) => item.key !== failedAction());
          const failed = () => waiting().find((item) => item.key === failedAction());
          const more = () => state()?.moreActions ?? 0;
          const line = createMemo(() => {
            if (!props.auth.online()) return "offline";
            const current = state();
            if (!current) return "checking";
            if (current.error) return "error";
            if (ready().length) return "pending";
            if (failed()) return "failed";
            return more() ? "more" : "idle";
          });
          const pending = () => line() === "pending";
          const summary = () => {
            const items = ready();
            if (items.length === 1) return items[0]!.title;
            return items.every((item) => item.login) ? t().loginRequests({ count: items.length }) : t().requests({ count: items.length });
          };
          const when = () => {
            const first = ready()[0];
            if (!first) return "";
            return ready().length > 1 ? t().oldest({ time: ago(first.at) }) : ago(first.at);
          };
          // What a screen reader hears for the card: the Cloud, its address, what waits, from where and when.
          const name = () => {
            const first = ready()[0];
            if (!first) return "";
            return `${binding.label}, ${host}. ${summary()}${first.from ? `, ${first.from}` : ""}, ${when()}`;
          };
          const opening = () => !!loadingAction()?.startsWith(`${binding.id}:`);
          const problem = () => {
            const error = state()?.error;
            if (line() === "error" && error) return problems[error].long();
            if (line() === "failed") return t().actionLoadFailed;
            return undefined;
          };
          const recheck = () => {
            if (rechecking()) return;
            setRechecking(true);
            // The icon turns at least once, so a quick answer still shows that something happened.
            const shown = new Promise((done) => setTimeout(done, 600));
            const item = failed();
            // A failed Action loads again and opens its sheet; the icon turns while it loads.
            if (line() === "failed" && item?.actionId) {
              void openAction([binding], item.actionId);
              void shown.then(() => setRechecking(false));
              return;
            }
            void Promise.all([props.auth.recheck(binding).catch(() => {}), shown]).then(() => setRechecking(false));
          };
          const Reload = () => (
            <>
              <IconButton
                class="auth-status__reload"
                label={t().recheck}
                variant="ghost"
                tooltip={false}
                data-busy={rechecking() || (line() === "failed" && opening()) ? "" : undefined}
                onClick={recheck}
              >
                <i class="ti ti-refresh" aria-hidden="true" />
              </IconButton>
              <span class="k2b-sr-only" role="status">
                {rechecking() ? t().rechecking : ""}
              </span>
            </>
          );
          return (
            <Paper
              as="section"
              class="auth-cloud"
              interactive={pending()}
              data-pending={pending() ? (ready().some((item) => item.warn) ? "warn" : "") : undefined}
            >
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
                  <p class="auth-issuer">{host}</p>
                </div>
                <IconButton
                  class="auth-cloud-info"
                  label={t().cloudDetails({ cloud: binding.label })}
                  variant="ghost"
                  tooltip={false}
                  onClick={() => void openDetails(props.auth, binding, props.preferences, problem())}
                >
                  <i class="ti ti-info-circle" aria-hidden="true" />
                </IconButton>
              </header>
              {/* One line in one place for every state, so nothing below it moves when the state changes. */}
              <Switch>
                <Match when={line() === "offline"}>
                  <p class="auth-status auth-quiet">{t().waitingForConnection}</p>
                </Match>
                <Match when={line() === "checking"}>
                  <p class="auth-status auth-quiet">{t().checking}</p>
                </Match>
                <Match when={line() === "error" && state()?.error}>
                  {(error) => (
                    <p class="auth-status" data-tone="error" role="status">
                      <i class={problems[error()].icon} aria-hidden="true" />
                      <span class="auth-status__text">
                        {problems[error()].text()}
                        <span class="k2b-sr-only">. {problems[error()].long()}</span>
                      </span>
                      <Show when={error() !== "forbidden"}>
                        <Reload />
                      </Show>
                    </p>
                  )}
                </Match>
                <Match when={line() === "failed"}>
                  <p class="auth-status" data-tone="error">
                    <i class="ti ti-alert-circle" aria-hidden="true" />
                    <span class="auth-status__text" role="alert">
                      {t().statusActionFailed}
                      <span class="k2b-sr-only">. {t().actionLoadFailed}</span>
                    </span>
                    <Reload />
                  </p>
                </Match>
                <Match when={line() === "pending"}>
                  <p class="auth-status" data-tone="pending">
                    <span class="auth-status__dot" aria-hidden="true" />
                    <span class="auth-status__text">
                      <b>{summary()}</b>
                      <span class="auth-status__sep" aria-hidden="true">
                        ·
                      </span>
                      <time dateTime={ready()[0]?.at}>{when()}</time>
                    </span>
                    <i
                      class={opening() ? "ti ti-loader-2 k2b-spin auth-status__chev" : "ti ti-chevron-right auth-status__chev"}
                      aria-hidden="true"
                    />
                  </p>
                </Match>
                <Match when={line() === "more"}>
                  <p class="auth-status auth-quiet">{t().moreActions({ count: more() })}</p>
                </Match>
                <Match when={line() === "idle"}>
                  <p class="auth-status auth-quiet">{t().noRequests}</p>
                </Match>
              </Switch>
              <Show when={more() > 0 && (line() === "pending" || line() === "failed")}>
                <p class="auth-status auth-status--more auth-quiet">{t().moreActions({ count: more() })}</p>
              </Show>
              {/* Only while something waits, the whole card opens the oldest request. It lies over the card's
                  content; the info button stays above it with its own target. */}
              <Show when={pending()}>
                <button
                  type="button"
                  class="auth-cloud__open"
                  aria-label={name()}
                  aria-busy={opening() ? "true" : undefined}
                  onClick={() => {
                    if (!opening()) ready()[0]?.open();
                  }}
                />
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
