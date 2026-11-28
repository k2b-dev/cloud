import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Dialog, Facts, Field, Input, Notice, Pane, Prose, Section, StatusRow, Steps, Text } from "@k2b/ui/v2";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { CHECK_STEPS, type StoreCheckResult } from "../../store/check-codes";
import type { StoreConfig, StoreStatus } from "../../store/contracts";
import { storeFixHint, storeMessages } from "./messages";
import { StoreClientError, storeClient } from "./store-client";

type Messages = ReturnType<typeof storeMessages.resolve>["t"];
type Step = (typeof CHECK_STEPS)[number];

/**
 * After the server snapshot: `loading` and `checking` only change the status row; everything else keeps its place,
 * so nothing moves while Pulse waits for ClickHouse.
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
  if (code.startsWith("CLICKHOUSE_ERROR:")) return t.failClickhouse;
  return t.failUnreachable;
};

/** The steps of a finished check, each with its outcome, and what to do about the first failure. */
function CheckOutcome(props: { status: StoreCheckResult; t: Messages; locale: string; note?: string }) {
  const word = (step: Step) => {
    const state = props.status.steps[step];
    return state === "ok" ? props.t.stepOk : state === "failed" ? props.t.stepFailed : props.t.stepSkipped;
  };
  return (
    <>
      <Show when={!props.status.ok}>
        <Notice
          tone="bad"
          icon="plug-x"
          title={failureTitle(props.t, props.status.code ?? "UNREACHABLE")}
          meta={props.status.code ?? "UNREACHABLE"}
        >
          {`${storeFixHint(props.status.code ?? "UNREACHABLE", props.locale)}${props.note ? ` ${props.note}` : ""}`}
        </Notice>
      </Show>
      <Facts items={CHECK_STEPS.map((step) => ({ label: stepLabel(props.t, step), value: word(step) }))} />
    </>
  );
}

/** Address, service user and password; saves only after the server's full check passed. */
function ConnectionFields(props: {
  t: Messages;
  locale: string;
  config: StoreConfig;
  initialPassword?: string;
  signal: AbortSignal;
  onSaved: (value: StoreStatus) => void;
  /** A save without an answer may still have been stored; the page reads the saved connection again. */
  onUncertain: () => void;
  submitLabel: string;
  /** In a dialog over the page: its title and how it closes; the buttons stand in its foot. */
  dialog?: { title: string; close: () => void };
  openScript: (user: string, password: string) => Promise<string | null>;
}) {
  const [url, setUrl] = createSignal(props.config.url);
  const [user, setUser] = createSignal(props.config.user);
  const [password, setPassword] = createSignal(props.initialPassword ?? "");
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
      else {
        const code = cause instanceof StoreClientError ? cause.code : "STORE_REQUEST_FAILED";
        setError(storeFixHint(code, props.locale));
        // Fixed refusals (input, password, busy) changed nothing; anything else may have saved.
        if (!["INVALID_INPUT", "PASSWORD_REQUIRED", "STORE_BUSY", "ACCESS_DENIED"].includes(code)) props.onUncertain();
      }
    } finally {
      setBusy(false);
    }
  };
  const fields = (
    <Band>
      <Field name="url" label={props.t.url} hint={props.t.urlDescription} required>
        <Input type="url" value={url()} placeholder="http://clickhouse:8123" disabled={busy()} onInput={setUrl} />
      </Field>
      <Field name="user" label={props.t.user} hint={props.t.userDescription} required>
        <Input value={user()} disabled={busy()} onInput={setUser} />
      </Field>
      <Field
        name="password"
        label={props.t.password}
        hint={props.config.passwordSet ? props.t.passwordKeep : props.t.passwordDescription}
        required={!props.config.passwordSet}
      >
        <Input
          type="password"
          value={password()}
          placeholder={props.config.passwordSet ? "••••••••••••" : undefined}
          disabled={busy()}
          onInput={setPassword}
        />
      </Field>
    </Band>
  );
  const buttons = (
    <>
      <Show when={props.dialog}>
        {(dialog) => (
          <Button disabled={busy()} onClick={() => dialog().close()}>
            {props.t.cancel}
          </Button>
        )}
      </Show>
      <Button
        icon="file-code"
        disabled={busy()}
        onClick={() =>
          void props.openScript(user().trim() || props.config.user, password()).then((chosen) => {
            if (chosen) setPassword(chosen);
          })
        }
      >
        {props.t.setupScript}
      </Button>
      <Button variant="primary" icon="plug-connected" busy={busy()} onClick={() => void submit()}>
        {props.submitLabel}
      </Button>
    </>
  );
  const outcome = (
    <>
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
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </>
  );
  return (
    <Show
      when={props.dialog}
      fallback={
        <>
          {fields}
          <Bar end={buttons} />
          {outcome}
        </>
      }
    >
      {(dialog) => (
        <Dialog
          title={dialog().title}
          open
          onOpenChange={(open) => {
            if (!open && !busy()) dialog().close();
          }}
          foot={buttons}
        >
          {outcome}
          {fields}
        </Dialog>
      )}
    </Show>
  );
}

/** Builds the setup script for a chosen or generated password; hands that password back when the person is done. */
function SetupScriptDialog(props: {
  t: Messages;
  locale: string;
  request: { user: string; password: string } | null;
  close: (password: string | null) => void;
}) {
  const [password, setPassword] = createSignal("");
  const [script, setScript] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  let opened: object | null = null;
  const reset = () => {
    const request = props.request;
    if (request && opened !== request) {
      opened = request;
      setPassword(request.password);
      setScript("");
      setError("");
    }
    return request !== null;
  };
  const create = async () => {
    const request = props.request;
    if (busy() || !request) return;
    if (!password()) return setError(storeFixHint("PASSWORD_REQUIRED", props.locale));
    setBusy(true);
    setError("");
    try {
      setScript((await storeClient.setupSql({ user: request.user, password: password() }, controller.signal)).sql);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(storeFixHint(cause instanceof StoreClientError ? cause.code : "STORE_REQUEST_FAILED", props.locale));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={props.t.scriptTitle}
      open={reset()}
      onOpenChange={(open) => {
        if (!open && !busy()) props.close(null);
      }}
      foot={
        <>
          <Button disabled={busy()} onClick={() => props.close(null)}>
            {props.t.cancel}
          </Button>
          <Show
            when={script()}
            fallback={
              <Button variant="primary" icon="file-code" busy={busy()} onClick={() => void create()}>
                {props.t.scriptCreate}
              </Button>
            }
          >
            <Button variant="primary" icon="check" onClick={() => props.close(password())}>
              {props.t.scriptDone}
            </Button>
          </Show>
        </>
      }
    >
      <Text>{props.t.scriptIntro}</Text>
      <Field name="scriptPassword" label={props.t.scriptPassword} hint={props.t.scriptPasswordDescription} error={error() || undefined}>
        <Input
          type="password"
          value={password()}
          disabled={busy()}
          onInput={(value) => {
            setPassword(value);
            setScript("");
          }}
          end={
            <Button
              variant="ghost"
              icon="dice-5"
              label={props.t.scriptGenerate}
              disabled={busy()}
              onClick={() => {
                setPassword(randomPassword());
                setScript("");
                void create();
              }}
            />
          }
        />
      </Field>
      <Show when={script()}>
        {(sql) => (
          <>
            {/* k2b-ui gap: no code block in v2 yet; the script stands as preformatted Markdown. */}
            <Prose markdown={`\`\`\`sql\n${sql()}\n\`\`\``} />
            <Text type="meta" muted>
              {props.t.scriptRun}
            </Text>
          </>
        )}
      </Show>
    </Dialog>
  );
}

/** The instance data store: its connection, the outcome of the last check, and how to set it up. */
export default function StoreView(props: { initial: StoreConfig; label: string }) {
  const locale = useLocale();
  const t = createMemo(() => storeMessages.resolve([locale()]).t);
  const [config, setConfig] = createSignal<StoreConfig>(props.initial);
  const [view, setView] = createSignal<View>({ kind: "loading" });
  // The last full check (save or "Check"); the status read only covers reach, sign-in and version.
  const [full, setFull] = createSignal<StoreCheckResult | null>(null);
  const [changing, setChanging] = createSignal<{ password?: string } | null>(null);
  const [script, setScript] = createSignal<{ user: string; password: string; done: (password: string | null) => void } | null>(null);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  // Times are formatted in the browser, in the person's own time zone.
  const time = (value: string) => new Intl.DateTimeFormat(locale(), { timeStyle: "short" }).format(new Date(value));

  // Every read, check and save starts a new generation; an older answer is dropped, so a slow status read never
  // puts the previous connection back over a save.
  let generation = 0;
  const load = async () => {
    const mine = ++generation;
    setView({ kind: "loading" });
    try {
      const value = await storeClient.get(controller.signal);
      if (mine !== generation) return;
      setConfig(value);
      setFull(null);
      setView(value.status ? { kind: "result", status: value.status } : { kind: "loading" });
    } catch {
      if (!controller.signal.aborted && mine === generation) setView({ kind: "error" });
    }
  };
  const check = async () => {
    if (busy()) return;
    const mine = ++generation;
    setView({ kind: "checking" });
    try {
      const status = await storeClient.check(controller.signal);
      if (mine !== generation) return;
      setFull(status);
      setView({ kind: "result", status });
    } catch {
      if (!controller.signal.aborted && mine === generation) setView({ kind: "error" });
    }
  };
  const saved = (value: StoreStatus) => {
    generation++;
    setConfig(value);
    if (value.status) {
      setFull(value.status);
      setView({ kind: "result", status: value.status });
    }
  };
  onMount(() => {
    if (props.initial.configured) void load();
  });
  const openScript = (user: string, password: string) => new Promise<string | null>((done) => setScript({ user, password, done }));
  const busy = () => view().kind === "loading" || view().kind === "checking";
  const lead = () => {
    const current = view();
    if (current.kind === "loading") return t().statusLoading;
    if (current.kind === "checking") return t().statusChecking;
    if (current.kind === "error") return t().statusRequestError;
    if (current.status.ok) return t().statusConnected;
    return current.status.code === "UNREACHABLE" ? t().statusUnreachable : t().statusFailed;
  };
  const facts = () => {
    const current = view();
    if (current.kind !== "result") return [];
    const status = current.status;
    if (!status.ok) return [{ value: status.code ?? "" }, { before: t().metaLastAttempt, value: time(status.checkedAt) }];
    return [
      ...(status.version ? [{ value: t().metaVersion({ version: status.version }) }] : []),
      ...(status.latencyMs !== undefined ? [{ value: t().metaLatency({ ms: status.latencyMs }) }] : []),
      { before: t().metaChecked, value: time(status.checkedAt) },
    ];
  };
  const latest = () => {
    const current = view();
    return full() ?? (current.kind === "result" ? current.status : null);
  };

  return (
    <Pane
      label={props.label}
      scrollKey="pulse-admin-store"
      status={config().configured ? <StatusRow lead={lead()} loading={busy()} facts={facts()} /> : undefined}
    >
      <Show
        when={config().configured}
        fallback={
          <>
            <Section icon="database-plus" title={t().notConfiguredTitle} summary={t().notConfiguredText}>
              <Steps
                label={t().notConfiguredTitle}
                items={[
                  { label: t().step1, state: "now" },
                  { label: t().step2, state: "next" },
                  { label: t().step3, state: "next" },
                ]}
              />
            </Section>
            <ConnectionFields
              t={t()}
              locale={locale()}
              config={config()}
              submitLabel={t().connect}
              signal={controller.signal}
              onSaved={saved}
              onUncertain={() => void load()}
              openScript={openScript}
            />
          </>
        }
      >
        <Show when={view().kind === "error"}>
          <Notice
            tone="bad"
            icon="plug-x"
            title={t().statusRequestError}
            actions={[{ label: t().check, icon: "refresh", onClick: () => void load() }]}
          >
            {t().statusRequestErrorMeta}
          </Notice>
        </Show>
        <Section
          icon="plug-connected"
          title={t().title}
          summary={t().description}
          actions={[
            { label: t().check, icon: "refresh", disabled: busy(), onClick: () => void (view().kind === "error" ? load() : check()) },
            { label: t().change, icon: "pencil", onClick: () => setChanging({}) },
          ]}
        >
          <Facts
            items={[
              { label: t().termAddress, value: config().url, mono: true, copy: config().url },
              { label: t().termService, value: config().user, mono: true },
              { label: t().password, value: t().passwordSaved },
            ]}
          />
        </Section>
        <Section
          icon="file-code"
          title={t().setupScript}
          summary={t().scriptIntro}
          actions={[
            {
              label: t().setupScript,
              icon: "file-code",
              // A script with a new password rotates it in ClickHouse; the connection dialog then checks and saves it.
              onClick: () => void openScript(config().user, "").then((chosen) => chosen && setChanging({ password: chosen })),
            },
          ]}
        />
        <Section icon="gauge" title={t().termProfiles} summary={t().profilesText} />
        <Section icon="database-export" title={t().termBackup} summary={t().backupText} />
        {/* Last on the page: a check result can grow here without moving anything above it. */}
        <Section
          icon="list-check"
          title={t().termCheck}
          summary={
            latest()?.ok && latest()?.steps.rights !== "skipped"
              ? t().checkFullOk
              : latest()?.ok
                ? t().checkConnectionOk
                : latest()
                  ? undefined
                  : t().checkPending
          }
        >
          <Show when={latest() && (!latest()!.ok || latest()!.steps.rights !== "skipped") ? latest() : null}>
            {(status) => <CheckOutcome status={status()} t={t()} locale={locale()} />}
          </Show>
        </Section>
      </Show>
      <Show when={changing()} keyed>
        {(request) => (
          <ConnectionFields
            t={t()}
            locale={locale()}
            config={config()}
            initialPassword={request.password}
            submitLabel={t().saveConnection}
            signal={controller.signal}
            dialog={{ title: t().changeTitle, close: () => setChanging(null) }}
            onSaved={(value) => {
              saved(value);
              setChanging(null);
            }}
            onUncertain={() => void load()}
            openScript={openScript}
          />
        )}
      </Show>
      <SetupScriptDialog
        t={t()}
        locale={locale()}
        request={script()}
        close={(password) => {
          script()?.done(password);
          setScript(null);
        }}
      />
    </Pane>
  );
}
