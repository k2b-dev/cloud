import { documentNavigate, refreshCurrentPath } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import {
  Button,
  ButtonLink,
  CodeDiff,
  Dropdown,
  type DropdownItem,
  NoticeCard,
  Placeholder,
  prompts,
  StatusBadge,
  type StatusTone,
  Tag,
  toast,
  useLocale,
  ViewTabs,
} from "@k2b/ui";
import { createMemo, createSignal, For, type JSX, Match, onCleanup, Show, Switch } from "solid-js";
import { z } from "zod";
import { openPanel } from "../../browser/panel";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import { CodeAccountHandle } from "./CodeAccountHandle";
import { CodeRefusalNotice } from "./CodeRefusalNotice";
import { CodeSecretsTab } from "./CodeSecrets";
import { loadCodeRunCalls } from "./calls";
import {
  ActivationSchema,
  type CodeActivationStatus,
  type CodePageAutomation,
  type CodePageCall,
  type CodePageData,
  type CodePageInvoke,
  type CodePageReady,
  type CodePageRefusal,
  type CodePageRun,
  type CodePageRunDetail,
  type CodePageTarget,
  type CodePageTargetRow,
  type CodePageVersion,
  coreQuery,
  RunListSchema,
  StartSchema,
  wrapped,
} from "./data";
import { type CodePageMessages, codePageMessages } from "./messages";
import { describeCodeSchedule } from "./schedule";

export { CodeNavStatus, codeNavAttentionLabel } from "./CodeNavStatus";
export type { CodeAttention, CodePageData, CodePageTab } from "./data";

/** The browser calls Core's public Code capabilities with the person's own session, like any page. */
const browserInvoke: CodePageInvoke = (invocation, schema) => invokeCapabilityWithDataSchema(invocation, schema);
/** Pause and resume return only the new state; the page reloads to show it. */
const ChangedSchema = z.object({ state: z.string() });

/** Polls bound the wait in the dialog; activation keeps going durably in Core after that. */
const ACTIVATION_POLLS = 90;
const ACTIVATION_POLL_MS = 1_000;

type ActivationRoute = "activate" | "activation/read";
/** Core's activation routes take only interactive credentials: the person's own browser session. */
const activationRequest = async (
  route: ActivationRoute,
  body: unknown,
): Promise<
  | { ok: true; data: CodeActivationStatus }
  /** `definite`: Core answered with a refusal, so it did not act. Otherwise the outcome is unknown. */
  | { ok: false; message: string | null; definite: boolean; notFound?: boolean }
> => {
  try {
    const response = await fetch(`/api/code/${route}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    const json: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = json && typeof json === "object" && "message" in json && typeof json.message === "string" ? json.message : null;
      return { ok: false, message, definite: response.status >= 400 && response.status < 500, notFound: response.status === 404 };
    }
    const parsed = wrapped(ActivationSchema).safeParse(json);
    return parsed.success ? { ok: true, data: parsed.data.data } : { ok: false, message: null, definite: false };
  } catch {
    return { ok: false, message: null, definite: false };
  }
};

/**
 * An activation whose outcome is unknown survives closing the dialog and reloading the page in this tab, so asking
 * again resumes it instead of starting a second one. It is cleared only by a confirmed result or a refusal.
 */
const pendingActivation = (codeId: string, versionId: string) => {
  const key = `cloud.code.activation:${codeId}:${versionId}`;
  return {
    read: (): string | null => {
      try {
        return sessionStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write: (id: string | null) => {
      try {
        if (id) sessionStorage.setItem(key, id);
        else sessionStorage.removeItem(key);
      } catch {
        // Without storage the identity lives as long as the dialog.
      }
    },
  };
};

const withQuery = (href: string, params: Record<string, string | undefined>): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `${href}?${text}` : href;
};

const shortId = (id: string) => `#${id.replaceAll("-", "").slice(0, 6)}`;

/** One context per page: messages, dates and the target names the page shows. */
function usePageText(data: () => CodePageData) {
  const locale = useLocale();
  const t = createMemo(() => codePageMessages.resolve([locale()]).t);
  const context = () => ({ ...data().dates, locale: locale() });
  const date = (iso: string) => dates.formatDate(iso, context());
  const when = (iso: string) => dates.formatDateTimeRelative(iso, { ...context(), base: data().dates.now });
  /** The parts of "today at 11:20" or "on 28.10.2026 at 11:20", in the page's time zone. */
  const moment = (iso: string) => ({
    today: dates.formatDate(iso, context()) === dates.formatDate(data().dates.now, context()),
    date: date(iso),
    time: dates.formatTime(iso, context()),
  });
  /** A foreign target is never named: its type and ID only, like cron names a path. */
  const targetName = (target: CodePageTarget): string => {
    if (target.own) return data().owner.title;
    if (target.ref.type === "app") return target.title ?? target.ref.id;
    return [target.typeTitle, target.ref.id].filter(Boolean).join(" ");
  };
  const targetLabel = (target: CodePageTarget): string => {
    const current = t();
    if (target.own) return current.atOwn({ name: data().owner.title });
    if (target.ref.type === "app") return current.atApp({ name: target.title ?? target.ref.id });
    if (target.typeTitle) return current.atTarget({ name: targetName(target) });
    return current.unknownTarget({ id: target.ref.id });
  };
  /** The service account a place's Code runs as; personal Code has none. */
  const account = () => (data().owner.kind === "resource" ? t().accountName({ name: data().owner.title }) : null);
  return { t, locale, date, when, moment, targetName, targetLabel, account };
}
type PageText = ReturnType<typeof usePageText>;

const runTone = (run: CodePageRun): StatusTone =>
  run.state === "succeeded"
    ? "ok"
    : run.state === "failed"
      ? "error"
      : run.state === "running" || run.state === "queued"
        ? "running"
        : run.state === "skipped"
          ? "neutral"
          : "warning";
const runStateLabel = (run: CodePageRun, t: CodePageMessages) =>
  ({
    queued: t.stateQueued,
    running: t.stateRunning,
    succeeded: t.stateSucceeded,
    failed: t.stateFailed,
    cancelled: t.stateCancelled,
    skipped: t.stateSkipped,
  })[run.state];
const triggerLabel = (run: CodePageRun, t: CodePageMessages) =>
  ({ schedule: t.triggerSchedule, manual: t.triggerManual, event: t.triggerEvent, path: t.triggerPath })[run.trigger];

/**
 * Switching on needs an editor, a waiting version that no administrator still has to approve, and the list of what
 * it asks for; without that list the person could not see what they confirm.
 */
const switchOnReady = (state: CodePageReady) =>
  state.permission === "editor" &&
  state.waiting !== null &&
  state.waiting.status !== "pending" &&
  state.waitingTargets !== null &&
  !state.versionsFailed;

/** Same rule as Core's attention query: a failed last run or a version waiting for approval. */
export const codePageNeedsAttention = (state: CodePageData["state"]): boolean =>
  state.kind === "ready" &&
  (state.attentionReasons !== null
    ? state.attentionReasons.length > 0
    : // Without Core's answer the page judges from what it loaded.
      (state.automations ?? []).some((automation) => automation.lastRun?.state === "failed") || state.waiting?.status === "pending");

/** "Copy link" shares this page, so the person who can switch it on lands right here. */
const copyPageLink = async (data: CodePageData, t: CodePageMessages) => {
  try {
    await navigator.clipboard.writeText(new URL(data.href, window.location.origin).href);
    toast.success(t.linkCopied);
  } catch {
    toast.error(t.linkCopyFailed);
  }
};

function Section(props: { title: string; count?: number; description?: string; children: JSX.Element; id?: string }) {
  return (
    <section class="cloud-code__section" aria-labelledby={props.id}>
      <div class="cloud-code__section-head">
        <h2 id={props.id} class="cloud-code__h2">
          {props.title}
          <Show when={props.count !== undefined}>
            <span class="cloud-code__count">{props.count}</span>
          </Show>
        </h2>
      </div>
      <Show when={props.description}>
        <p class="cloud-code__section-sub">{props.description}</p>
      </Show>
      {props.children}
    </section>
  );
}

function InlineError(props: { text: string; retry: string }) {
  return (
    <div class="cloud-code__inline-error" role="alert">
      <i class="ti ti-cloud-off" aria-hidden="true" />
      <span>{props.text}</span>
      <Button type="button" size="sm" variant="secondary" onClick={() => refreshCurrentPath()}>
        <i class="ti ti-refresh" aria-hidden="true" />
        {props.retry}
      </Button>
    </div>
  );
}

const Op = (props: { children: string }) => <code class="cloud-code__op">{props.children}</code>;

/** The shared Code page of one resource: automations, targets, runs with their calls, versions, switching on. */
/** Personal Code runs as its person; it has no place that it acts for. */
const personal = (data: CodePageData) => data.owner.kind === "person";

export default function CodePage(props: { data: CodePageData }) {
  const text = usePageText(() => props.data);
  const t = text.t;
  return (
    <div class="cloud-code" data-tab={props.data.tab}>
      {/* Personal Code is titled by its own name; a place's Code is "Code", and the lead names the place. */}
      <Show
        when={personal(props.data)}
        fallback={
          <h1 class="cloud-code__page-title">
            <span aria-hidden="true">{t().placeTitle}</span>
            <span class="sr-only">{t().pageTitle({ name: props.data.owner.title })}</span>
          </h1>
        }
      >
        <h1 class="cloud-code__page-title">
          <i class="ti ti-bolt" aria-hidden="true" />
          {props.data.owner.title || t().personalErrorTitle}
        </h1>
      </Show>
      <Switch>
        <Match when={props.data.state.kind === "error"}>
          <Placeholder
            state="error"
            variant="panel"
            icon="ti ti-cloud-off"
            title={personal(props.data) ? t().personalErrorTitle : t().errorTitle({ name: props.data.owner.title })}
            description={personal(props.data) ? t().personalErrorDescription : t().errorDescription({ name: props.data.owner.title })}
            onRetry={() => refreshCurrentPath()}
          />
        </Match>
        <Match when={props.data.state.kind === "no-access"}>
          <Placeholder
            state="no-access"
            variant="panel"
            icon="ti ti-lock"
            title={t().noAccessTitle}
            description={personal(props.data) ? t().personalNoAccessDescription : t().noAccessDescription({ name: props.data.owner.title })}
          />
        </Match>
        <Match when={props.data.state.kind === "none"}>
          <EmptyCode data={props.data} text={text} />
        </Match>
        <Match when={props.data.state.kind === "ready" && (props.data.state as CodePageReady)}>
          {(state) => <ReadyPage data={props.data} state={state()} text={text} />}
        </Match>
      </Switch>
    </div>
  );
}

function EmptyCode(props: { data: CodePageData; text: PageText }) {
  const t = props.text.t;
  const command = () =>
    props.data.owner.ref ? `cld code pull ${props.data.owner.ref.type.split(".")[0]}/${props.data.owner.ref.id}` : "cld code pull --all";
  return (
    <div class="cloud-code__empty">
      <Placeholder
        state="empty"
        variant="panel"
        icon="ti ti-code"
        title={t().emptyTitle({ name: props.data.owner.title })}
        description={t().emptyDescription({ name: props.data.owner.title, editor: props.data.editor?.label ?? null })}
        action={
          <Show when={props.data.editor}>
            {(editor) => (
              <Button type="button" variant="primary" onClick={() => openPanel(editor().provider)}>
                <i class={editor().icon} aria-hidden="true" />
                {t().createWith({ name: editor().label })}
              </Button>
            )}
          </Show>
        }
      />
      <p class="cloud-code__terminal">
        {t().emptyTerminal} <code>{command()}</code>
      </p>
    </div>
  );
}

function ReadyPage(props: { data: CodePageData; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const editor = () => props.state.permission === "editor";
  const [busy, setBusy] = createSignal<"pause" | "resume" | null>(null);
  const setPaused = async (paused: boolean) => {
    if (busy()) return;
    setBusy(paused ? "pause" : "resume");
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: paused ? "code.pause" : "code.resume",
        kind: "action",
        target: { type: "core.code", id: props.state.code.id },
        input: {},
        idempotencyKey: crypto.randomUUID(),
      },
      ChangedSchema,
    );
    setBusy(null);
    if (!result.ok) {
      toast.error(paused ? t().pauseFailed : t().resumeFailed);
      return;
    }
    toast.success(paused ? t().paused : t().resumed);
    refreshCurrentPath();
  };
  const activate = () => {
    const version = props.state.waiting;
    if (!version) return;
    void openActivationDialog({ data: props.data, state: props.state, version, text: props.text });
  };
  const tabs = () => [
    { id: "overview", label: t().tabOverview, href: props.data.href },
    { id: "runs", label: t().tabRuns, href: withQuery(props.data.href, { tab: "runs" }) },
    ...(editor() ? [{ id: "secrets", label: t().tabSecrets, href: withQuery(props.data.href, { tab: "secrets" }) }] : []),
    {
      id: "versions",
      label: t().tabVersions,
      href: withQuery(props.data.href, { tab: "versions" }),
      count: props.state.versions.length || undefined,
    },
  ];
  const menu = (): DropdownItem[] => [
    ...(editor() && props.state.code.state === "active"
      ? [{ label: t().pause, icon: "ti ti-player-pause", action: () => void setPaused(true), disabled: busy() !== null }]
      : []),
    ...(editor() && props.state.code.state === "paused"
      ? [{ label: t().resume, icon: "ti ti-player-play", action: () => void setPaused(false), disabled: busy() !== null }]
      : []),
    { label: t().copyLink, icon: "ti ti-link", action: () => void copyPageLink(props.data, t()) },
  ];
  const canSwitchOn = () => switchOnReady(props.state);
  return (
    <>
      <header class="cloud-code__head">
        <div class="cloud-code__head-text">
          <p class="cloud-code__lead">
            {!personal(props.data) ? (
              <AccountLine state={props.state} text={props.text} />
            ) : !props.data.owner.runsAs ? (
              t().personalLead
            ) : props.data.owner.runsAs.name ? (
              t().personalLeadOf({ name: props.data.owner.runsAs.name })
            ) : (
              t().personalLeadOfSomeone
            )}
          </p>
          <VersionLine data={props.data} state={props.state} text={props.text} />
        </div>
        <div class="cloud-code__head-actions">
          <Show when={canSwitchOn()}>
            <Button type="button" variant="primary" onClick={() => activate()}>
              <i class="ti ti-power" aria-hidden="true" />
              {t().switchOnVersion({ version: props.state.waiting!.number })}
            </Button>
          </Show>
          <Show when={editor() && props.data.editor}>
            {(panel) => (
              <Button type="button" variant="secondary" onClick={() => openPanel(panel().provider)}>
                <i class={panel().icon} aria-hidden="true" />
                {t().editWith({ name: panel().label })}
              </Button>
            )}
          </Show>
          <Show when={props.state.active ?? props.state.waiting}>
            {(version) => (
              <ButtonLink
                href={withQuery(props.data.href, { tab: "versions", version: version().id })}
                variant="secondary"
                aria-label={t().viewCode}
              >
                <i class="ti ti-code" aria-hidden="true" />
                <span class="cloud-code__wide-label">{t().viewCode}</span>
              </ButtonLink>
            )}
          </Show>
          <Dropdown.Root items={menu()} label={t().more} position="bottom-right" phone="sheet">
            <Dropdown.Trigger iconOnly type="button" variant="ghost" label={t().more} aria-busy={busy() ? "true" : undefined}>
              <i class={busy() ? "ti ti-loader-2 animate-spin" : "ti ti-dots"} aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
      </header>
      <ViewTabs label={t().tabsLabel} items={tabs()} current={props.data.tab} class="cloud-code__tabs" />
      <Switch>
        <Match when={props.data.tab === "overview"}>
          <Overview data={props.data} state={props.state} text={props.text} onActivate={activate} />
        </Match>
        <Match when={props.data.tab === "runs"}>
          <Runs data={props.data} state={props.state} text={props.text} />
        </Match>
        <Match when={props.data.tab === "secrets"}>
          <CodeSecretsTab data={props.data} state={props.state} />
        </Match>
        <Match when={props.data.tab === "versions"}>
          <Versions data={props.data} state={props.state} text={props.text} onActivate={() => activate()} />
        </Match>
      </Switch>
    </>
  );
}

function VersionLine(props: { data: CodePageData; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  return (
    <p class="cloud-code__vline">
      <Show
        when={props.state.active}
        fallback={
          <Show when={props.state.waiting}>
            {(waiting) => (
              <span>
                {waiting().createdBy
                  ? t().draftLine({
                      version: waiting().number,
                      name: waiting().createdBy!.name,
                      date: props.text.when(waiting().createdAt),
                    })
                  : t().draftLineNoName({ version: waiting().number, date: props.text.when(waiting().createdAt) })}
              </span>
            )}
          </Show>
        }
      >
        {(active) => (
          <>
            <span>
              <b>{t().versionLine({ version: active().number })}</b>
            </span>
            <Show when={props.state.waiting}>
              {(waiting) => (
                <span>
                  {waiting().createdBy
                    ? t().draftLine({
                        version: waiting().number,
                        name: waiting().createdBy!.name,
                        date: props.text.when(waiting().createdAt),
                      })
                    : t().draftLineNoName({ version: waiting().number, date: props.text.when(waiting().createdAt) })}
                </span>
              )}
            </Show>
          </>
        )}
      </Show>
      <span>
        <i class="ti ti-history" aria-hidden="true" /> {t().versionsCount({ count: props.state.versions.length })}
      </span>
      <span>
        <i class="ti ti-link-off" aria-hidden="true" /> {t().noAddress}
      </span>
    </p>
  );
}

function Overview(props: { data: CodePageData; state: CodePageReady; text: PageText; onActivate: () => void }) {
  const t = props.text.t;
  const editor = () => props.state.permission === "editor";
  const newOperations = () =>
    (props.state.waitingTargets ?? [])
      .filter((row) => row.isNew && !row.target.own)
      .flatMap((row) => row.operations.map((operation) => `${operation} ${props.text.targetLabel(row.target)}`));
  const running = () => props.state.active?.number ?? null;
  return (
    <div class="cloud-code__body">
      <Show when={props.data.activatedNotice !== null && props.data.activatedNotice === props.state.active?.number}>
        <NoticeCard
          tone="success"
          icon="ti ti-circle-check"
          title={t().activatedTitle({ version: props.data.activatedNotice! })}
          detail={t().activatedDescription}
        />
      </Show>
      <Show when={props.state.waiting}>
        {(waiting) => (
          <Show
            when={waiting().status !== "pending"}
            fallback={
              <NoticeCard
                tone="neutral"
                icon="ti ti-hourglass"
                title={t().waitingApprovalTitle({ version: waiting().number })}
                detail={t().waitingApproval({ running: running() })}
              >
                <div class="cloud-code__note-actions">
                  <ButtonLink size="sm" variant="secondary" href={withQuery(props.data.href, { tab: "versions", version: waiting().id })}>
                    <i class="ti ti-git-compare" aria-hidden="true" />
                    {t().showDiff}
                  </ButtonLink>
                </div>
              </NoticeCard>
            }
          >
            <NoticeCard
              tone="neutral"
              icon="ti ti-sparkles"
              title={t().waitingReadyTitle({ version: waiting().number })}
              detail={[
                newOperations().length > 0 ? t().needsNewAccess({ operations: newOperations().join(", ") }) : "",
                running() === null ? t().waitingReadyFirst : t().waitingReadyNew({ version: waiting().number, running: running() }),
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div class="cloud-code__note-actions">
                <Show when={switchOnReady(props.state)}>
                  <Button type="button" size="sm" variant="primary" onClick={() => props.onActivate()}>
                    <i class="ti ti-power" aria-hidden="true" />
                    {t().switchOn}
                  </Button>
                </Show>
                <ButtonLink size="sm" variant="secondary" href={withQuery(props.data.href, { tab: "versions", version: waiting().id })}>
                  <i class="ti ti-git-compare" aria-hidden="true" />
                  {t().showDiff}
                </ButtonLink>
              </div>
            </NoticeCard>
          </Show>
        )}
      </Show>
      <Show when={props.state.code.needsReconfirmation}>
        <NoticeCard tone="warning" title={t().reconfirmTitle} detail={t().reconfirmDescription} />
      </Show>
      <Show when={props.state.code.state === "paused"}>
        <NoticeCard
          tone="warning"
          icon="ti ti-player-pause"
          title={t().pausedTitle}
          detail={props.state.code.pauseReason ?? t().pausedDescription}
        >
          <Show when={editor()}>
            <div class="cloud-code__note-actions">
              <ResumeButton codeId={props.state.code.id} t={t()} />
            </div>
          </Show>
        </NoticeCard>
      </Show>
      <Show when={props.state.refusal}>
        {(refusal) => <LastRunRefusal data={props.data} state={props.state} refusal={refusal()} text={props.text} />}
      </Show>
      <Show when={props.state.versionsFailed}>
        <InlineError text={t().versionsFailed} retry={t().tryAgain} />
      </Show>
      <Section id="cloud-code-automations" title={t().automations} count={props.state.automations?.length}>
        <Show when={props.state.automations} fallback={<InlineError text={t().automationsFailed} retry={t().tryAgain} />}>
          {(automations) => (
            <Show when={automations().length > 0} fallback={<p class="cloud-code__quiet">{t().automationsEmpty}</p>}>
              <div class="cloud-code__list" role="table" aria-label={t().automations}>
                <div class="cloud-code__row cloud-code__row--automation cloud-code__row--head" role="row">
                  <span role="columnheader" />
                  <span role="columnheader">{t().name}</span>
                  <span role="columnheader" class="cloud-code__wide">
                    {t().status}
                  </span>
                  <span role="columnheader" class="cloud-code__wide cloud-code__num">
                    {t().lastRun}
                  </span>
                </div>
                <For each={automations()}>
                  {(automation) => <AutomationRow data={props.data} state={props.state} automation={automation} text={props.text} />}
                </For>
              </div>
            </Show>
          )}
        </Show>
      </Section>
      <Section
        id="cloud-code-targets"
        title={t().targets}
        description={!personal(props.data) ? t().targetsDescription : props.data.owner.runsAs ? t().personalAccessOf : t().personalAccess}
      >
        <Show when={!personal(props.data)}>
          <Show when={props.state.targets} fallback={<InlineError text={t().targetsFailed} retry={t().tryAgain} />}>
            {(targets) => (
              <Show
                when={targets().some((row) => !row.target.own)}
                fallback={<p class="cloud-code__quiet">{t().targetsEmpty({ name: props.data.owner.title })}</p>}
              >
                <ul class="cloud-code__list">
                  <For each={targets()}>{(row) => <TargetRow row={row} state={props.state} text={props.text} />}</For>
                </ul>
              </Show>
            )}
          </Show>
        </Show>
      </Section>
      <Show
        when={
          props.state.internet.active === null ||
          props.state.internet.waiting === null ||
          props.state.internet.active.length ||
          props.state.internet.waiting.length
        }
      >
        <Section id="cloud-code-internet" title={t().internetOrigins} description={t().internetDescription}>
          <Show
            when={props.state.internet.active !== null && props.state.internet.waiting !== null}
            fallback={<InlineError text={t().internetFailed} retry={t().tryAgain} />}
          >
            <Show when={props.state.active && props.state.internet.active?.length}>
              <p class="cloud-code__label">{t().internetVersion({ version: props.state.active!.number })}</p>
              <ul class="cloud-code__list">
                <For each={props.state.internet.active ?? []}>{(origin) => <OriginRow origin={origin} />}</For>
              </ul>
            </Show>
            <Show when={props.state.waiting && props.state.internet.waiting?.length}>
              <p class="cloud-code__label">{t().internetVersion({ version: props.state.waiting!.number })}</p>
              <ul class="cloud-code__list">
                <For each={props.state.internet.waiting ?? []}>
                  {(origin) => (
                    <OriginRow origin={origin}>
                      <Show when={!props.state.internet.active?.includes(origin)}>
                        <span class="cloud-code__new">{t().newOnSwitchOn({ version: props.state.waiting?.number ?? 0 })}</span>
                      </Show>
                    </OriginRow>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Section>
      </Show>
      <Section id="cloud-code-pages" title={t().pagesAndRoutes} count={0}>
        <p class="cloud-code__quiet">{t().pagesNone}</p>
      </Section>
    </div>
  );
}

/** One declared internet origin, laid out like an access row; the children mark it, for example as new. */
function OriginRow(props: { origin: string; children?: JSX.Element }) {
  return (
    <li class="cloud-code__row cloud-code__row--access">
      <span class="cloud-code__kind" aria-hidden="true">
        <i class="ti ti-world" />
      </span>
      <span class="cloud-code__cell break-all">
        <Op>{props.origin}</Op>
      </span>
      <span class="cloud-code__right">{props.children}</span>
    </li>
  );
}

function ResumeButton(props: { codeId: string; t: CodePageMessages }) {
  const [busy, setBusy] = createSignal(false);
  const resume = async () => {
    setBusy(true);
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: "code.resume",
        kind: "action",
        target: { type: "core.code", id: props.codeId },
        input: {},
        idempotencyKey: crypto.randomUUID(),
      },
      ChangedSchema,
    );
    setBusy(false);
    if (!result.ok) return toast.error(props.t.resumeFailed);
    refreshCurrentPath();
  };
  return (
    <Button type="button" size="sm" variant="secondary" loading={busy()} onClick={() => void resume()}>
      <i class="ti ti-player-play" aria-hidden="true" />
      {props.t.resume}
    </Button>
  );
}

function AutomationRow(props: { data: CodePageData; state: CodePageReady; automation: CodePageAutomation; text: PageText }) {
  const t = props.text.t;
  const status = (): { tone: StatusTone; label: string } => {
    if (props.automation.isNew) return { tone: "neutral", label: t().statusOff({ version: props.state.waiting?.number ?? 0 }) };
    if (props.state.code.state === "paused") return { tone: "warning", label: t().statusPaused };
    if (props.automation.lastRun?.state === "failed") return { tone: "error", label: t().statusLastFailed };
    return { tone: "ok", label: t().statusOn };
  };
  const [starting, setStarting] = createSignal(false);
  const runNow = async () => {
    setStarting(true);
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: "code.run",
        kind: "action",
        target: { type: "core.code", id: props.state.code.id },
        input: { entrypoint: props.automation.entrypoint, input: null },
        idempotencyKey: crypto.randomUUID(),
      },
      StartSchema,
    );
    setStarting(false);
    if (!result.ok) return toast.error(result.error.message);
    toast.success(t().runStarted);
    documentNavigate(withQuery(props.data.href, { tab: "runs", run: result.data.data.runId }));
  };
  const schedule = () =>
    props.automation.kind === "schedule" && props.automation.cron
      ? describeCodeSchedule(props.automation.cron, props.text.locale())
      : t().manualStart;
  return (
    <div class="cloud-code__row cloud-code__row--automation" role="row">
      <span class="cloud-code__kind" aria-hidden="true">
        <i class={props.automation.kind === "schedule" ? "ti ti-clock" : "ti ti-hand-finger"} />
      </span>
      <span class="cloud-code__cell" role="cell">
        <span class="cloud-code__title">
          {props.automation.title ?? props.automation.entrypoint}
          <Show when={props.automation.isNew}>
            <Tag>{t().newTag}</Tag>
          </Show>
        </span>
        <span class="cloud-code__sub">
          {schedule()}
          <Show when={props.automation.nextRunAt}>{(at) => <> · {t().nextRun({ when: props.text.when(at()) })}</>}</Show>
        </span>
        <span class="cloud-code__sub cloud-code__narrow">{status().label}</span>
      </span>
      <span class="cloud-code__wide" role="cell">
        <StatusBadge tone={status().tone} label={status().label} variant="dot" />
      </span>
      <span class="cloud-code__wide cloud-code__num" role="cell">
        <Show when={props.automation.lastRun} fallback={<span class="text-dimmed">{props.automation.isNew ? "—" : t().noRunYet}</span>}>
          {(run) => <a href={withQuery(props.data.href, { tab: "runs", run: run().id })}>{props.text.when(run().createdAt)}</a>}
        </Show>
        <Show
          when={
            props.automation.kind === "manual" &&
            !props.automation.isNew &&
            props.state.permission === "editor" &&
            props.state.code.state === "active"
          }
        >
          <Button type="button" size="xs" variant="ghost" loading={starting()} onClick={() => void runNow()}>
            {t().runNow}
          </Button>
        </Show>
      </span>
    </div>
  );
}

/** Operations the Code calls at one target, linked when the type's page needs only the ID. */
function TargetRow(props: { row: CodePageTargetRow; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  return (
    <li class="cloud-code__row cloud-code__row--access">
      <span class="cloud-code__kind" aria-hidden="true">
        <i class={props.row.target.icon ?? (props.row.target.own ? "ti ti-home" : "ti ti-target-arrow")} />
      </span>
      <span class="cloud-code__cell">
        <span class="cloud-code__ops">
          <For each={[...props.row.operations, ...props.row.newOperations]}>{(operation) => <Op>{operation}</Op>}</For>
        </span>
        <span class="cloud-code__sub">
          <TargetText target={props.row.target} text={props.text} />
        </span>
      </span>
      <span class="cloud-code__right">
        <Show when={props.row.newOperations.length > 0}>
          <span class="cloud-code__new">
            {props.row.operations.length === 0
              ? t().newOnSwitchOn({ version: props.state.waiting?.number ?? 0 })
              : t().alsoNew({ operations: props.row.newOperations.join(", ") })}
          </span>
        </Show>
      </span>
    </li>
  );
}

/** "at Space sp_2lg8", the ID linked where its type's page allows; the own place and apps by name. */
function TargetText(props: { target: CodePageTarget; text: PageText }) {
  return (
    <Show when={props.target.href && !props.target.own} fallback={props.text.targetLabel(props.target)}>
      <a href={props.target.href!}>{props.text.targetLabel(props.target)}</a>
    </Show>
  );
}

/** "Runs as service account “Code of …”", with its handle to copy once Core provides it, also before the first run. */
function AccountLine(props: { state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  return (
    <>
      {t().runsAsAccount({ name: props.text.account() ?? props.state.code.title })}
      <Show when={props.state.code.serviceAccountHandle}>
        {(handle) => (
          <>
            {" "}
            <CodeAccountHandle handle={handle()} />
          </>
        )}
      </Show>
    </>
  );
}

/** The newest finished run failed with a refused call: shown first, under "Last run", as the mockup's cron page does. */
function LastRunRefusal(props: { data: CodePageData; state: CodePageReady; refusal: CodePageRefusal; text: PageText }) {
  const t = props.text.t;
  const run = () => props.state.runs?.items.find((item) => item.id === props.refusal.runId) ?? null;
  return (
    <section class="cloud-code__section" aria-labelledby="cloud-code-last-run">
      <div class="cloud-code__section-head">
        <h2 id="cloud-code-last-run" class="cloud-code__h2 cloud-code__h2--wrap">
          <span>{t().lastRun}</span>
          <Show when={run()}>
            {(current) => (
              <a class="cloud-code__count" href={withQuery(props.data.href, { tab: "runs", run: current().id })}>
                {props.text.when(current().createdAt)} · {current().title ?? current().entrypoint}
              </a>
            )}
          </Show>
        </h2>
      </div>
      <CodeRefusalNotice
        refusal={props.refusal}
        account={props.text.account()}
        runsAsOther={Boolean(props.data.owner.runsAs)}
        handle={props.state.code.serviceAccountHandle ?? null}
        editor={props.state.permission === "editor"}
        cloudAdmin={props.data.cloudAdmin}
      />
    </section>
  );
}

function Runs(props: { data: CodePageData; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const [items, setItems] = createSignal(props.state.runs?.items ?? []);
  const [cursor, setCursor] = createSignal(props.state.runs?.nextCursor ?? null);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const selected = () => props.state.run?.run.id ?? null;
  const loadMore = async () => {
    const next = cursor();
    if (!next || loading()) return;
    setLoading(true);
    setFailed(false);
    const result = await browserInvoke(coreQuery("code.run.list", { codeId: props.state.code.id, limit: 20, cursor: next }), RunListSchema);
    setLoading(false);
    if (!result.ok) return setFailed(true);
    const numbers = new Map(props.state.versions.map((version) => [version.id, version.number]));
    setItems([...items(), ...result.data.data.items.map((run) => ({ ...run, versionNumber: numbers.get(run.versionId) ?? null }))]);
    setCursor(result.data.data.nextCursor);
  };
  return (
    <div class="cloud-code__body cloud-code__runs">
      <Show when={props.state.runs} fallback={<InlineError text={t().runsFailed} retry={t().tryAgain} />}>
        <section class="cloud-code__run-list" aria-label={t().runs}>
          <Show when={items().length > 0} fallback={<p class="cloud-code__quiet">{t().runsEmpty}</p>}>
            <ul class="cloud-code__list">
              <For each={items()}>
                {(run) => (
                  <li>
                    <a
                      class="cloud-code__row cloud-code__row--run"
                      href={withQuery(props.data.href, { tab: "runs", run: run.id })}
                      aria-current={run.id === selected() ? "true" : undefined}
                    >
                      <span class="cloud-code__cell">
                        <span class="cloud-code__title">
                          {shortId(run.id)} · {run.title ?? run.entrypoint}
                        </span>
                        <span class="cloud-code__sub">
                          {[
                            props.text.when(run.createdAt),
                            triggerLabel(run, t()),
                            run.versionNumber ? t().runVersion({ version: run.versionNumber }) : null,
                            run.rerunByName ? t().rerunBy({ name: run.rerunByName }) : run.rerunOf ? t().rerunUnnamed : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        <Show when={run.state === "skipped" && run.outcome}>
                          <span class="cloud-code__sub">{t().outcome({ code: run.outcome! })}</span>
                        </Show>
                      </span>
                      <StatusBadge tone={runTone(run)} label={runStateLabel(run, t())} variant="dot" />
                    </a>
                  </li>
                )}
              </For>
            </ul>
            <Show when={failed()}>
              <p class="cloud-code__bad" role="alert">
                {t().runsFailed}
              </p>
            </Show>
            <Show when={cursor()}>
              <Button type="button" size="sm" variant="ghost" loading={loading()} onClick={() => void loadMore()}>
                {t().loadMore}
              </Button>
            </Show>
          </Show>
        </section>
        <Show
          when={props.state.run}
          fallback={
            <Show when={props.state.selectionFailed}>
              <InlineError text={t().runFailedToLoad} retry={t().tryAgain} />
            </Show>
          }
        >
          {(detail) => <RunDetail data={props.data} state={props.state} detail={detail()} text={props.text} />}
        </Show>
      </Show>
    </div>
  );
}

function RunDetail(props: { data: CodePageData; state: CodePageReady; detail: CodePageRunDetail; text: PageText }) {
  const t = props.text.t;
  const run = () => props.detail.run;
  const [calls, setCalls] = createSignal<CodePageCall[] | null>(props.detail.calls);
  const [next, setNext] = createSignal(props.detail.nextCallCursor);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [rerunning, setRerunning] = createSignal(false);
  const afterAction = () => (calls() ?? []).some((call) => call.kind === "action");
  /** Only the complete call list proves that a failed run never reached an action. */
  const beforeFirstAction = () => calls() !== null && !afterAction() && next() === null;
  const canRerun = () =>
    run().state === "failed" && afterAction() && props.state.permission === "editor" && props.state.code.state === "active";
  const loadMore = async () => {
    const after = next();
    if (after === null || loading()) return;
    setLoading(true);
    setFailed(false);
    const result = await loadCodeRunCalls(browserInvoke, props.state.code.id, run().id, after, undefined, props.text.locale());
    setLoading(false);
    if (!result) return setFailed(true);
    setCalls([...(calls() ?? []), ...result.calls]);
    setNext(result.next);
  };
  /** Stable outcomes that only repeat the state add nothing to the note. */
  const outcomeText = () => {
    const outcome = run().outcome;
    return outcome && outcome !== "failed" && outcome !== "succeeded" ? t().outcome({ code: outcome }) : null;
  };
  const rerun = async () => {
    // The input is too large to carry along; Core keeps it, and cld code can start the run again.
    if (props.detail.inputTooLarge) return toast.error(t().rerunNeedsInput);
    setRerunning(true);
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: "code.run",
        kind: "action",
        target: { type: "core.code", id: props.state.code.id },
        input: { entrypoint: run().entrypoint, input: props.detail.input ?? null, rerunOf: run().id },
        // One rerun per failed run, also after a lost response or a double click.
        idempotencyKey: `rerun:${run().id}`,
      },
      StartSchema,
    );
    setRerunning(false);
    if (!result.ok) return toast.error(t().rerunFailed);
    toast.success(t().rerunStarted);
    documentNavigate(withQuery(props.data.href, { tab: "runs", run: result.data.data.runId }));
  };
  const canViewWithPanel = () => props.state.permission === "editor" && props.data.editor !== null;
  /** Looking at a failed run with the panel; the panel reads this page's place as its context. */
  const viewWithPanelButton = () => (
    <Show when={canViewWithPanel() && props.data.editor}>
      {(panel) => (
        <Button type="button" size="sm" variant="secondary" onClick={() => openPanel(panel().provider)}>
          <i class={panel().icon} aria-hidden="true" />
          {t().viewWith({ name: panel().label })}
        </Button>
      )}
    </Show>
  );
  const viewWithPanel = () => (
    <Show when={canViewWithPanel()}>
      <div class="cloud-code__note-actions">{viewWithPanelButton()}</div>
    </Show>
  );
  const target = (call: CodePageCall) => {
    if (!call.target) return null;
    const known = [
      ...(props.state.targets ?? []).map((row) => row.target),
      ...(props.state.waitingTargets ?? []).map((row) => row.target),
    ].find((candidate) => candidate.ref.type === call.target!.type && candidate.ref.id === call.target!.id);
    return props.text.targetLabel(known ?? { key: "", ref: call.target, title: null, typeTitle: null, icon: null, own: false, href: null });
  };
  return (
    <section class="cloud-code__run-detail" aria-labelledby="cloud-code-run-title">
      <div class="cloud-code__run-head">
        <div class="min-w-0">
          <h2 id="cloud-code-run-title" class="cloud-code__h2">
            {shortId(run().id)} · {run().title ?? run().entrypoint}
          </h2>
          <p class="cloud-code__sub">
            {[
              props.text.when(run().createdAt),
              run().versionNumber ? t().runVersion({ version: run().versionNumber! }) : null,
              triggerLabel(run(), t()),
              run().rerunByName ? t().rerunBy({ name: run().rerunByName! }) : run().rerunOf ? t().rerunUnnamed : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <StatusBadge tone={runTone(run())} label={runStateLabel(run(), t())} />
      </div>
      <Show when={props.detail.refusal}>
        {(refusal) => (
          <CodeRefusalNotice
            refusal={refusal()}
            account={props.text.account()}
            runsAsOther={Boolean(props.data.owner.runsAs)}
            handle={props.state.code.serviceAccountHandle ?? null}
            editor={props.state.permission === "editor"}
            cloudAdmin={props.data.cloudAdmin}
            actions={canRerun() || canViewWithPanel()}
          >
            <Show when={canRerun()}>
              <Button type="button" size="sm" variant="secondary" loading={rerunning()} onClick={() => void rerun()}>
                <i class="ti ti-repeat" aria-hidden="true" />
                {t().rerun}
              </Button>
            </Show>
            {viewWithPanelButton()}
          </CodeRefusalNotice>
        )}
      </Show>
      <Show when={run().state === "failed" && !props.detail.refusal}>
        <Show
          when={afterAction()}
          fallback={
            <Show
              when={beforeFirstAction()}
              fallback={
                <NoticeCard tone="danger" icon="ti ti-circle-x" title={t().stateFailed} detail={outcomeText() ?? undefined}>
                  {viewWithPanel()}
                </NoticeCard>
              }
            >
              <NoticeCard
                tone="danger"
                icon="ti ti-circle-x"
                title={t().failedBeforeFirstTitle}
                detail={[outcomeText(), t().failedBeforeFirst].filter(Boolean).join(". ")}
              >
                {viewWithPanel()}
              </NoticeCard>
            </Show>
          }
        >
          <NoticeCard
            tone="danger"
            icon="ti ti-circle-x"
            title={t().failedAfterFirstTitle}
            detail={[outcomeText(), t().failedAfterFirst].filter(Boolean).join(". ")}
          >
            <Show when={canRerun() || canViewWithPanel()}>
              <div class="cloud-code__note-actions">
                <Show when={canRerun()}>
                  <Button type="button" size="sm" variant="secondary" loading={rerunning()} onClick={() => void rerun()}>
                    <i class="ti ti-repeat" aria-hidden="true" />
                    {t().rerun}
                  </Button>
                </Show>
                {viewWithPanelButton()}
              </div>
            </Show>
          </NoticeCard>
        </Show>
      </Show>
      <Show when={run().state !== "failed" && run().outcome && run().outcome !== "succeeded"}>
        <p class="cloud-code__quiet">{t().outcome({ code: run().outcome! })}</p>
      </Show>
      <Show when={run().rerunOf}>
        {(original) => (
          <p class="cloud-code__quiet">
            <a href={withQuery(props.data.href, { tab: "runs", run: original() })}>{t().rerunOf({ run: shortId(original()) })}</a>
          </p>
        )}
      </Show>
      <Show when={calls()} fallback={<p class="cloud-code__quiet">{t().callsHidden}</p>}>
        {(list) => (
          <>
            <p class="cloud-code__label">
              {t().calls} <span class="cloud-code__count">{list().length}</span>
            </p>
            <Show when={list().length > 0} fallback={<p class="cloud-code__quiet">{t().callsEmpty}</p>}>
              <ol class="cloud-code__calls">
                <For each={list()}>
                  {(call) => (
                    <li class="cloud-code__call" data-state={call.state}>
                      <i
                        class={
                          call.state === "succeeded"
                            ? "ti ti-circle-check"
                            : call.state === "failed"
                              ? "ti ti-circle-x"
                              : call.state === "running"
                                ? "ti ti-loader-2"
                                : "ti ti-circle-dashed"
                        }
                        aria-hidden="true"
                      />
                      <span class="cloud-code__cell">
                        <span>
                          <Op>{call.capability}</Op> <span class="text-secondary">{target(call)}</span>
                        </span>
                        <span class="cloud-code__sub">{call.state === "uncertain" ? t().callUnknown : call.summary}</span>
                      </span>
                    </li>
                  )}
                </For>
              </ol>
            </Show>
            <Show when={failed()}>
              <p class="cloud-code__bad" role="alert">
                {t().callsFailed}
              </p>
            </Show>
            <Show when={next() !== null}>
              <Button type="button" size="sm" variant="ghost" loading={loading()} onClick={() => void loadMore()}>
                {t().moreCalls}
              </Button>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

function Versions(props: { data: CodePageData; state: CodePageReady; text: PageText; onActivate: () => void }) {
  const t = props.text.t;
  const status = (version: CodePageVersion): { tone: StatusTone; label: string } =>
    version.active
      ? { tone: "ok", label: t().versionStatus({ status: "active" }) }
      : {
          tone: version.status === "pending" ? "info" : version.status === "rejected" ? "error" : "neutral",
          label: version.status ? t().versionStatus({ status: version.status }) : "",
        };
  return (
    <div class="cloud-code__body cloud-code__versions">
      <section aria-label={t().versions} class="cloud-code__run-list">
        <Show when={props.state.versionsFailed}>
          <InlineError text={t().versionsFailed} retry={t().tryAgain} />
        </Show>
        <ul class="cloud-code__list">
          <For each={props.state.versions}>
            {(version) => (
              <li>
                <a
                  class="cloud-code__row cloud-code__row--run"
                  href={withQuery(props.data.href, { tab: "versions", version: version.id })}
                  aria-current={props.state.diff?.version.id === version.id ? "true" : undefined}
                >
                  <span class="cloud-code__cell">
                    <span class="cloud-code__title">{t().versionLine({ version: version.number })}</span>
                    <span class="cloud-code__sub">
                      {version.createdBy
                        ? t().versionBy({ name: version.createdBy.name, date: props.text.date(version.createdAt) })
                        : props.text.date(version.createdAt)}
                    </span>
                    <Show when={version.decisionLabel}>
                      <span class="cloud-code__sub">{version.decisionLabel}</span>
                    </Show>
                  </span>
                  <StatusBadge tone={status(version).tone} label={status(version).label} variant="dot" />
                </a>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.state.moreVersions}>
          <p class="cloud-code__quiet">{t().versionsMore}</p>
        </Show>
      </section>
      <Show
        when={props.state.diff}
        fallback={
          <Show when={props.state.selectionFailed}>
            <InlineError text={t().versionFailedToLoad} retry={t().tryAgain} />
          </Show>
        }
      >
        {(diff) => (
          <section class="cloud-code__run-detail" aria-labelledby="cloud-code-version-title">
            <div class="cloud-code__run-head">
              <div class="min-w-0">
                <h2 id="cloud-code-version-title" class="cloud-code__h2">
                  {(() => {
                    const comparison = diff().comparison;
                    if (comparison === null) return t().firstVersion({ version: diff().version.number });
                    if (comparison === "unknown") return t().comparedWithEarlier({ version: diff().version.number });
                    return t().comparedWith({ version: diff().version.number, previous: comparison });
                  })()}
                </h2>
                <Show when={diff().version.decisionLabel}>
                  <p class="cloud-code__sub">{diff().version.decisionLabel}</p>
                </Show>
              </div>
              <Show when={switchOnReady(props.state) && props.state.waiting?.id === diff().version.id}>
                <Button type="button" variant="primary" onClick={() => props.onActivate()}>
                  <i class="ti ti-power" aria-hidden="true" />
                  {t().switchOnVersion({ version: diff().version.number })}
                </Button>
              </Show>
            </div>
            <Show when={diff().staleComparison}>
              <NoticeCard tone="info" icon="ti ti-info-circle" detail={t().staleComparison} title={t().codeDiff} />
            </Show>
            <p class="cloud-code__label">{t().permissionsTitle}</p>
            <Show when={diff().permissions.length > 0} fallback={<p class="cloud-code__quiet">{t().noPermissions}</p>}>
              <ul class="cloud-code__list">
                <For each={diff().permissions}>
                  {(permission) => (
                    <li class="cloud-code__row cloud-code__row--access">
                      <span class="cloud-code__kind" aria-hidden="true">
                        <i class={permission.target?.icon ?? (permission.target?.own ? "ti ti-home" : "ti ti-target-arrow")} />
                      </span>
                      <span class="cloud-code__cell">
                        <Op>{permission.operation}</Op>
                        <span class="cloud-code__sub">{permission.target ? props.text.targetLabel(permission.target) : ""}</span>
                      </span>
                      <span class="cloud-code__right text-dimmed">{t().line({ file: permission.file, line: permission.line })}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={diff().internet === null || diff().internet?.length}>
              <p class="cloud-code__label">{t().internetOrigins}</p>
              <Show when={diff().internet} fallback={<InlineError text={t().internetFailed} retry={t().tryAgain} />}>
                {(origins) => (
                  <ul class="cloud-code__list">
                    <For each={origins()}>{(origin) => <OriginRow origin={origin} />}</For>
                  </ul>
                )}
              </Show>
            </Show>
            <p class="cloud-code__label">{t().codeDiff}</p>
            <CodeDiff files={diff().files} label={t().codeDiff} />
          </section>
        )}
      </Show>
    </div>
  );
}

type ActivationView =
  | { kind: "idle" }
  | { kind: "progress"; state: CodeActivationStatus["state"] }
  /** Core's answer is missing or the wait ended: the activation may still run, so nothing claims it did not. */
  | { kind: "unknown" }
  | { kind: "failed"; failure: NonNullable<CodeActivationStatus["failure"]> | null; message: string | null };

/** "Switch on": reviews the version, then runs Core's durable activation and shows its result. */
async function openActivationDialog(params: { data: CodePageData; state: CodePageReady; version: CodePageVersion; text: PageText }) {
  const t = params.text.t();
  await prompts.dialog<void>((close) => <ActivationDialog {...params} close={() => close()} />, {
    title: t.activateTitle({ version: params.version.number }),
    icon: "ti ti-power",
    size: "large",
  });
}

function ActivationDialog(props: {
  data: CodePageData;
  state: CodePageReady;
  version: CodePageVersion;
  text: PageText;
  close: () => void;
}) {
  const t = props.text.t;
  const [view, setView] = createSignal<ActivationView>({ kind: "idle" });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const running = () => props.state.active?.number ?? null;
  const newAutomations = () =>
    (props.state.automations ?? [])
      .filter((automation) => automation.isNew)
      .map((automation) => `„${automation.title ?? automation.entrypoint}“`);
  // One identity per attempt: after a lost answer, asking again with it returns the same durable activation.
  // Only a confirmed terminal result or a refusal starts a new identity.
  const pending = pendingActivation(props.state.code.id, props.version.id);
  const resumed = pending.read();
  let activationId = resumed ?? crypto.randomUUID();
  const finish = () => {
    pending.write(null);
    activationId = crypto.randomUUID();
  };
  /** Applies one status; true when it ended the wait. */
  const settle = (status: CodeActivationStatus): boolean => {
    if (status.state === "active") {
      pending.write(null);
      props.close();
      documentNavigate(withQuery(props.data.href, { activated: String(props.version.number) }));
      return true;
    }
    if (status.state === "failed" || status.state === "cancelled") {
      finish();
      setView({ kind: "failed", failure: status.failure, message: null });
      return true;
    }
    setView({ kind: "progress", state: status.state });
    return false;
  };
  const follow = async () => {
    for (let poll = 0; poll < ACTIVATION_POLLS && !disposed; poll++) {
      await new Promise((resolve) => setTimeout(resolve, ACTIVATION_POLL_MS));
      if (disposed) return;
      const read = await activationRequest("activation/read", { codeId: props.state.code.id, activationId });
      if (read.ok && settle(read.data)) return;
    }
    if (!disposed) setView({ kind: "unknown" });
  };
  /** Reads the status only; it never starts an activation. */
  const check = async () => {
    setView({ kind: "progress", state: "pending" });
    const read = await activationRequest("activation/read", { codeId: props.state.code.id, activationId });
    if (read.ok) {
      if (!settle(read.data)) await follow();
      return;
    }
    // Core has no such activation: nothing changed, and switching on again may reuse this identity.
    if (read.notFound) {
      pending.write(null);
      return setView({ kind: "failed", failure: null, message: null });
    }
    setView({ kind: "unknown" });
  };
  const start = async () => {
    setView({ kind: "progress", state: "pending" });
    pending.write(activationId);
    const started = await activationRequest("activate", { codeId: props.state.code.id, versionId: props.version.id, activationId });
    if (started.ok) {
      if (!settle(started.data)) await follow();
      return;
    }
    if (started.definite) {
      // Core refused before acting; a later attempt is a new activation.
      finish();
      return setView({ kind: "failed", failure: null, message: started.message });
    }
    // The answer was lost: Core may have accepted. Its status says what happened.
    await check();
  };
  // A dialog opened while an earlier attempt is unresolved continues with that attempt.
  if (resumed) void check();
  const failureText = (): string | null => {
    const current = view();
    if (current.kind !== "failed") return null;
    if (!current.failure) return current.message ?? t().activationUnavailable;
    return t().failedGeneric({ reason: current.failure.reason });
  };
  const progressText = () => {
    const current = view();
    if (current.kind === "unknown") return t().activationUnknown({ running: running() });
    if (current.kind !== "progress") return null;
    if (current.state === "waiting") return t().waitingOwner({ running: running() });
    if (current.state === "applying" || current.state === "rolling_back") return t().applying;
    return t().checking;
  };
  const busy = () => view().kind === "progress";
  return (
    <div class="cloud-code__dialog">
      <p>{personal(props.data) ? t().personalActivateIntro : t().activateIntro({ name: props.data.owner.title })}</p>
      <Show when={(props.state.internet.waiting?.filter((origin) => !props.state.internet.active?.includes(origin)).length ?? 0) > 0}>
        <p class="cloud-code__label">{t().internet}</p>
        <ul class="cloud-code__list">
          <For each={props.state.internet.waiting?.filter((origin) => !props.state.internet.active?.includes(origin)) ?? []}>
            {(origin) => (
              <li class="cloud-code__row cloud-code__row--access">
                <span class="cloud-code__kind" aria-hidden="true">
                  <i class="ti ti-world" />
                </span>
                <span class="cloud-code__cell">
                  <Op>{origin}</Op>
                </span>
                <span class="cloud-code__right text-secondary">{t().newAccess}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={newAutomations().length > 0}>
        <p class="text-secondary">
          {t().newAutomations({ version: props.version.number, names: newAutomations().join(", ") })}{" "}
          <a class="k2b-text-link" href={withQuery(props.data.href, { tab: "versions", version: props.version.id })}>
            {t().showDiff}
          </a>
        </p>
      </Show>
      <Show when={!props.data.activation.allowed}>
        <NoticeCard
          tone="warning"
          icon="ti ti-device-mobile-off"
          detail={props.data.activation.allowed ? "" : props.data.activation.reason === "phone" ? t().phoneBlocked : t().credentialBlocked}
          title={t().switchOn}
        />
      </Show>
      <Show when={progressText()}>
        {(progress) => (
          <p class="cloud-code__progress" role="status">
            <i class="ti ti-loader-2 animate-spin" aria-hidden="true" /> {progress()}
          </p>
        )}
      </Show>
      <Show when={failureText()}>
        {(failure) => (
          <NoticeCard
            tone="danger"
            icon="ti ti-alert-triangle"
            title={failure()}
            detail={t().nothingChanged({ running: running() })}
            role="alert"
          />
        )}
      </Show>
      <div class="cloud-code__dialog-actions">
        <Button type="button" variant="secondary" onClick={() => props.close()}>
          {view().kind === "idle" ? t().cancel : t().close}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!props.data.activation.allowed || busy()}
          loading={busy() && view().kind === "progress" && (view() as { state: string }).state !== "waiting"}
          onClick={() => void (view().kind === "unknown" ? check() : start())}
        >
          <i class="ti ti-power" aria-hidden="true" />
          {view().kind === "unknown"
            ? t().checkStatus
            : view().kind === "failed"
              ? t().tryAgain
              : t().switchOnVersion({ version: props.version.number })}
        </Button>
      </div>
    </div>
  );
}
