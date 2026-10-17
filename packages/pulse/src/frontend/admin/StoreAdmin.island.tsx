import {
  Button,
  CodeDisplay,
  DescriptionList,
  Format,
  NoticeCard,
  prompts,
  StatusBadge,
  type StatusTone,
  Steps,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { CHECK_STEPS, type StoreCheckResult } from "../../store/check";
import type { StoreConfig, StoreStatus } from "../../store/contracts";
import { storeFixHint, storeMessages } from "./messages";
import { StoreClientError, storeClient } from "./store-client";

type Messages = ReturnType<typeof storeMessages.resolve>["t"];
type Step = (typeof CHECK_STEPS)[number];

/**
 * The view after the server snapshot: `loading` and `checking` are transient and only change the
 * status line; every other element keeps its place, so nothing moves while Pulse waits for ClickHouse.
 */
type View = { kind: "loading" } | { kind: "checking" } | { kind: "result"; status: StoreCheckResult } | { kind: "error" };

const stepLabel = (t: Messages, step: Step) =>
  ({ reach: t.stepReach, auth: t.stepAuth, version: t.stepVersion, rights: t.stepRights, profiles: t.stepProfiles })[step];

const randomPassword = () => [...crypto.getRandomValues(new Uint8Array(24))].map((n) => n.toString(16).padStart(2, "0")).join("");

const failureTitle = (t: Messages, code: string) => {
  if (code === "AUTH_FAILED") return t.failAuth;
  if (code === "VERSION_TOO_OLD") return t.failVersion;
  if (code === "TOO_MANY_RIGHTS") return t.failTooManyRights;
  if (code.startsWith("MISSING_RIGHT:")) return t.failRight;
  if (code.startsWith("PROFILE_MISSING:")) return t.failProfile;
  return t.failUnreachable;
};

/** The steps of a finished check and what to do about the first failure. */
const CheckOutcome = (props: { status: StoreCheckResult; t: Messages; locale: string; note?: string }) => (
  <div class="flex flex-col gap-3" aria-live="polite">
    <Show when={!props.status.ok}>
      <NoticeCard
        tone="danger"
        title={failureTitle(props.t, props.status.code ?? "UNREACHABLE")}
        detail={`${storeFixHint(props.status.code ?? "UNREACHABLE", props.locale)}${props.note ? ` ${props.note}` : ""}`}
        meta={props.status.code ?? "UNREACHABLE"}
      />
    </Show>
    <ul class="flex flex-wrap gap-x-4 gap-y-1.5" aria-label={props.t.termCheck}>
      <For each={CHECK_STEPS}>
        {(step) => {
          const state = () => props.status.steps[step];
          return (
            <li>
              <StatusBadge
                variant="text"
                tone={state() === "ok" ? "ok" : state() === "failed" ? "error" : "neutral"}
                icon={state() === "ok" ? "ti ti-circle-check" : state() === "failed" ? "ti ti-circle-x" : "ti ti-circle-dashed"}
                label={stepLabel(props.t, step)}
                title={state() === "ok" ? props.t.stepOk : state() === "failed" ? props.t.stepFailed : props.t.stepSkipped}
              />
              <span class="sr-only">
                : {state() === "ok" ? props.t.stepOk : state() === "failed" ? props.t.stepFailed : props.t.stepSkipped}
              </span>
            </li>
          );
        }}
      </For>
    </ul>
  </div>
);

type FormProps = {
  t: Messages;
  locale: string;
  config: StoreConfig;
  submitLabel: string;
  onSaved: (value: StoreStatus) => void;
  onCancel?: () => void;
  signal: AbortSignal;
};

/** Address, service user and password; saves only after the server's full check passed. */
const ConnectionForm = (props: FormProps) => {
  const [url, setUrl] = createSignal(props.config.url);
  const [user, setUser] = createSignal(props.config.user);
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal<StoreCheckResult | null>(null);
  const [error, setError] = createSignal("");
  const submit = async () => {
    if (busy()) return;
    setBusy(true);
    setError("");
    setFailed(null);
    try {
      const value = await storeClient.save(
        { url: url().trim(), user: user().trim(), ...(password() ? { password: password() } : {}) },
        props.signal,
      );
      setPassword("");
      props.onSaved(value);
    } catch (cause) {
      if (props.signal.aborted) return;
      if (cause instanceof StoreClientError && cause.check) setFailed(cause.check);
      else setError(storeFixHint(cause instanceof StoreClientError ? cause.code : "STORE_REQUEST_FAILED", props.locale));
    } finally {
      setBusy(false);
    }
  };
  const openScript = async () => {
    const chosen = await openSetupScript(props.t, props.locale, user().trim() || props.config.user, password());
    if (chosen) setPassword(chosen);
  };
  return (
    <form
      class="flex max-w-xl flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <TextInput
        label={props.t.url}
        description={props.t.urlDescription}
        type="url"
        placeholder="http://clickhouse:8123"
        value={url()}
        onValueChange={setUrl}
        required
        monospace
        autocomplete="off"
        spellcheck={false}
        disabled={busy()}
      />
      <TextInput
        label={props.t.user}
        description={props.t.userDescription}
        value={user()}
        onValueChange={setUser}
        required
        monospace
        autocomplete="off"
        spellcheck={false}
        disabled={busy()}
      />
      <TextInput
        label={props.t.password}
        description={props.config.passwordSet ? props.t.passwordKeep : props.t.passwordDescription}
        password
        value={password()}
        onValueChange={setPassword}
        placeholder={props.config.passwordSet ? "••••••••••••" : undefined}
        required={!props.config.passwordSet}
        autocomplete="new-password"
        disabled={busy()}
      />
      <div class="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" disabled={busy()} onClick={() => void openScript()}>
          <i class="ti ti-file-code" aria-hidden="true" />
          {props.t.setupScript}
        </Button>
        <Button type="submit" variant="primary" loading={busy()} loadingLabel={props.t.statusChecking}>
          <i class="ti ti-plug-connected" aria-hidden="true" />
          {props.submitLabel}
        </Button>
        <Show when={props.onCancel}>
          {(cancel) => (
            <Button type="button" variant="ghost" disabled={busy()} onClick={() => cancel()()}>
              {props.t.cancel}
            </Button>
          )}
        </Show>
      </div>
      <Show when={failed()}>
        {(status) => (
          <CheckOutcome
            status={status()}
            t={props.t}
            locale={props.locale}
            note={props.config.configured ? props.t.notSaved : props.t.notSavedNew}
          />
        )}
      </Show>
      <Show when={error()}>{(message) => <NoticeCard tone="danger" title={message()} />}</Show>
    </form>
  );
};

/** Builds the setup script for a chosen or generated password; resolves with the password the form should use. */
const openSetupScript = (t: Messages, locale: string, user: string, initialPassword: string) =>
  prompts.dialog<string>(
    (close) => {
      const [password, setPassword] = createSignal(initialPassword);
      const [script, setScript] = createSignal("");
      const [busy, setBusy] = createSignal(false);
      const [error, setError] = createSignal("");
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      const create = async () => {
        if (busy()) return;
        if (!password()) {
          setError(storeFixHint("PASSWORD_REQUIRED", locale));
          return;
        }
        setBusy(true);
        setError("");
        try {
          setScript((await storeClient.setupSql({ user, password: password() }, controller.signal)).sql);
        } catch (cause) {
          if (!controller.signal.aborted)
            setError(storeFixHint(cause instanceof StoreClientError ? cause.code : "STORE_REQUEST_FAILED", locale));
        } finally {
          setBusy(false);
        }
      };
      return (
        <div class="flex flex-col gap-4">
          <p class="text-sm text-secondary">{t.scriptIntro}</p>
          <TextInput
            label={t.scriptPassword}
            description={t.scriptPasswordDescription}
            password
            value={password()}
            onValueChange={(value) => {
              setPassword(value);
              setScript("");
            }}
            error={error() || undefined}
            autocomplete="new-password"
            disabled={busy()}
          />
          <div class="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={busy()}
              onClick={() => {
                setPassword(randomPassword());
                setScript("");
                void create();
              }}
            >
              <i class="ti ti-dice-5" aria-hidden="true" />
              {t.scriptGenerate}
            </Button>
            <Button type="button" variant="primary" loading={busy()} onClick={() => void create()}>
              <i class="ti ti-file-code" aria-hidden="true" />
              {t.scriptCreate}
            </Button>
          </div>
          <Show when={script()}>
            {(sql) => (
              <>
                <CodeDisplay code={sql()} title="pulse-setup.sql" lineNumbers={false} />
                <p class="text-xs text-dimmed">{t.scriptRun}</p>
                <div class="flex justify-end">
                  <Button type="button" variant="primary" onClick={() => close(password())}>
                    {t.scriptDone}
                  </Button>
                </div>
              </>
            )}
          </Show>
        </div>
      );
    },
    { title: t.scriptTitle, icon: "ti ti-file-code", size: "large" },
  );

const statusTone = (view: View): StatusTone => {
  if (view.kind === "loading" || view.kind === "checking") return "running";
  if (view.kind === "error") return "warning";
  return view.status.ok ? "ok" : "error";
};

export default function StoreAdmin(props: { initial: StoreConfig }) {
  const locale = useLocale();
  const t = createMemo(() => storeMessages.resolve([locale()]).t);
  const [config, setConfig] = createSignal<StoreConfig>(props.initial);
  const [view, setView] = createSignal<View>({ kind: "loading" });
  // The last result of a full check (save or "Check"); the status read only covers reach, sign-in and version.
  const [full, setFull] = createSignal<StoreCheckResult | null>(null);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  // Times are formatted only after the browser read them, in the person's own time zone.
  const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

  const load = async () => {
    setView({ kind: "loading" });
    try {
      const value = await storeClient.get(controller.signal);
      setConfig(value);
      setView(value.status ? { kind: "result", status: value.status } : { kind: "loading" });
    } catch {
      if (!controller.signal.aborted) setView({ kind: "error" });
    }
  };
  const check = async () => {
    if (view().kind === "checking" || view().kind === "loading") return;
    setView({ kind: "checking" });
    try {
      const status = await storeClient.check(controller.signal);
      setFull(status);
      setView({ kind: "result", status });
    } catch {
      if (!controller.signal.aborted) setView({ kind: "error" });
    }
  };
  const saved = (value: StoreStatus) => {
    setConfig(value);
    if (value.status) {
      setFull(value.status);
      setView({ kind: "result", status: value.status });
    }
  };
  onMount(() => {
    if (props.initial.configured) void load();
  });

  const busy = () => view().kind === "loading" || view().kind === "checking";
  const statusTitle = () => {
    const current = view();
    if (current.kind === "loading") return t().statusLoading;
    if (current.kind === "checking") return t().statusChecking;
    if (current.kind === "error") return t().statusRequestError;
    if (current.status.ok) return t().statusConnected;
    return current.status.code === "UNREACHABLE" ? t().statusUnreachable : t().statusFailed;
  };
  const statusMeta = (): JSX.Element => {
    const current = view();
    if (current.kind === "error")
      return (
        <>
          {t().statusRequestErrorMeta}{" "}
          <Button variant="text" size="xs" onClick={() => void load()}>
            {t().retry}
          </Button>
        </>
      );
    if (current.kind !== "result") return " ";
    const status = current.status;
    const time = <Format.Time value={status.checkedAt} timeZone={timeZone()} />;
    if (!status.ok)
      return (
        <>
          {status.code} · {t().metaLastAttempt} {time}
        </>
      );
    return (
      <>
        <Show when={status.version}>{(version) => t().metaVersion({ version: version() })}</Show>
        <Show when={status.latencyMs !== undefined}> · {t().metaLatency({ ms: status.latencyMs ?? 0 })}</Show> · {t().metaChecked} {time}
      </>
    );
  };
  // The full check's outcome when one ran; otherwise what the status read confirmed.
  const checkContent = (): JSX.Element => {
    const current = view();
    const latest = full() ?? (current.kind === "result" ? current.status : null);
    if (latest && (!latest.ok || latest.steps.rights !== "skipped"))
      return (
        <div class="flex flex-col gap-3">
          <Show when={latest.ok}>
            <p class="text-sm text-secondary">{t().checkFullOk}</p>
          </Show>
          <CheckOutcome status={latest} t={t()} locale={locale()} />
        </div>
      );
    return <p class="text-sm text-secondary">{latest?.ok ? t().checkConnectionOk : t().checkPending}</p>;
  };
  const changeConnection = () =>
    prompts.dialog<void>(
      (close) => (
        <ConnectionForm
          t={t()}
          locale={locale()}
          config={config()}
          submitLabel={t().saveConnection}
          signal={controller.signal}
          onSaved={(value) => {
            saved(value);
            close();
          }}
          onCancel={() => close()}
        />
      ),
      { title: t().changeTitle, icon: "ti ti-plug-connected" },
    );

  const section = (id: string, title: string, children: JSX.Element) => (
    <section class="flex flex-col gap-2" aria-labelledby={id}>
      <h2 id={id} class="text-sm font-semibold text-primary">
        {title}
      </h2>
      {children}
    </section>
  );

  return (
    <div class="flex max-w-4xl flex-col gap-6">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 flex-1 basis-72">
          <h1 class="text-base font-semibold text-primary">{t().title}</h1>
          <p class="mt-1 text-xs text-dimmed">{t().description}</p>
        </div>
        <Show when={config().configured}>
          <div class="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void openSetupScript(t(), locale(), config().user, "")}>
              <i class="ti ti-file-code" aria-hidden="true" />
              {t().setupScript}
            </Button>
            <Button variant="secondary" disabled={busy()} onClick={() => void (view().kind === "error" ? load() : check())}>
              <i class={`ti ti-refresh${busy() ? " animate-spin" : ""}`} aria-hidden="true" />
              {t().check}
            </Button>
          </div>
        </Show>
      </header>

      <Show
        when={config().configured}
        fallback={
          <div class="flex flex-col gap-6">
            {section(
              "pulse-store-setup",
              t().notConfiguredTitle,
              <div class="flex max-w-2xl flex-col gap-4">
                <p class="text-sm text-secondary">{t().notConfiguredText}</p>
                <Steps>
                  <li>{t().step1}</li>
                  <li>{t().step2}</li>
                  <li>{t().step3}</li>
                </Steps>
              </div>,
            )}
            <ConnectionForm
              t={t()}
              locale={locale()}
              config={config()}
              submitLabel={t().connect}
              onSaved={saved}
              signal={controller.signal}
            />
          </div>
        }
      >
        <section class="flex flex-col gap-1" aria-live="polite" aria-busy={busy()}>
          <StatusBadge
            variant="dot"
            tone={statusTone(view())}
            label={<span class="text-sm font-medium text-primary">{statusTitle()}</span>}
          />
          {/* Reserved for the tallest meta: two text lines, or a line with the retry button, on phones; one
              button-high line from sm up. Nothing below the status line moves when it changes. */}
          <p class="min-h-10 text-xs text-dimmed sm:min-h-6">{statusMeta()}</p>
        </section>
        <DescriptionList
          layout="rows"
          items={[
            { term: t().termAddress, description: <span class="font-mono break-all">{config().url}</span> },
            {
              term: t().termService,
              description: <span class="font-mono">{config().user}</span>,
              action: (
                <Button size="xs" variant="ghost" onClick={() => void changeConnection()}>
                  {t().change}
                </Button>
              ),
            },
            { term: t().password, description: t().passwordSaved },
          ]}
        />
        {section("pulse-store-limits", t().termProfiles, <p class="text-sm text-secondary">{t().profilesText}</p>)}
        {section("pulse-store-backup", t().termBackup, <p class="text-sm text-secondary">{t().backupText}</p>)}
        {/* Last on the page: a check result can grow here without moving anything above it. */}
        {section("pulse-store-check", t().termCheck, checkContent())}
      </Show>
    </div>
  );
}
