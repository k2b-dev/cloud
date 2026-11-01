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
import { loadCodeRunCalls } from "./calls";
import {
  ActivationSchema,
  type CodeActivationStatus,
  type CodePageAccessRow,
  type CodePageActivationRow,
  type CodePageAutomation,
  type CodePageCall,
  type CodePageData,
  type CodePageInvoke,
  type CodePageReady,
  type CodePageRun,
  type CodePageRunDetail,
  type CodePageTarget,
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
const ChangedSchema = wrapped(z.object({ state: z.string() }));

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
  const targetName = (target: CodePageTarget): string => {
    if (target.own) return data().owner.title;
    if (target.ref.type === "app") return target.title ?? target.ref.id;
    if (target.title) return [target.typeTitle, target.title].filter(Boolean).join(" ");
    return target.ref.id;
  };
  const targetLabel = (target: CodePageTarget): string => {
    const current = t();
    if (target.own) return current.atOwn({ name: data().owner.title });
    if (target.ref.type === "app") return current.atApp({ name: target.title ?? target.ref.id });
    if (target.title) return `${current.atTarget({ name: targetName(target) })} (${target.ref.id})`;
    return current.unknownTarget({ id: target.ref.id });
  };
  return { t, locale, date, when, targetName, targetLabel };
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

/** Opens the panel that works on Code with the person, when one is offered. */
function EditWithPanel(props: { data: CodePageData; t: CodePageMessages; size?: "sm" }) {
  return (
    <Show when={props.data.editor}>
      {(panel) => (
        <Button type="button" size={props.size} variant="secondary" onClick={() => openPanel(panel().provider)}>
          <i class="ti ti-sparkles" aria-hidden="true" />
          {props.t.editWith({ name: panel().label })}
        </Button>
      )}
    </Show>
  );
}

/** Same rule as Core's attention query: a failed last run, missing access, or a version waiting for approval. */
export const codePageNeedsAttention = (state: CodePageData["state"]): boolean =>
  state.kind === "ready" &&
  (state.attentionReasons !== null
    ? state.attentionReasons.length > 0
    : // Without Core's answer the page judges from what it loaded.
      (state.automations ?? []).some((automation) => automation.lastRun?.state === "failed") ||
      (state.access ?? []).some((row) => row.state === "removed") ||
      state.waiting?.status === "pending");

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

/** The shared Code page of one resource: automations, access, runs with their calls, versions, switching on. */
export default function CodePage(props: { data: CodePageData }) {
  const text = usePageText(() => props.data);
  const t = text.t;
  return (
    <div class="cloud-code" data-tab={props.data.tab}>
      <h1 class="sr-only">{t().pageTitle({ name: props.data.owner.title })}</h1>
      <Switch>
        <Match when={props.data.state.kind === "error"}>
          <Placeholder
            state="error"
            variant="panel"
            icon="ti ti-cloud-off"
            title={t().errorTitle({ name: props.data.owner.title })}
            description={t().errorDescription({ name: props.data.owner.title })}
            onRetry={() => refreshCurrentPath()}
          />
        </Match>
        <Match when={props.data.state.kind === "no-access"}>
          <Placeholder
            state="no-access"
            variant="panel"
            icon="ti ti-lock"
            title={t().noAccessTitle}
            description={t().noAccessDescription({ name: props.data.owner.title })}
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
  const command = () => `cld code pull ${props.data.owner.ref.type.split(".")[0]}/${props.data.owner.ref.id}`;
  return (
    <div class="cloud-code__empty">
      <Placeholder
        state="empty"
        variant="panel"
        icon="ti ti-code"
        title={t().emptyTitle({ name: props.data.owner.title })}
        description={t().emptyDescription({ name: props.data.owner.title })}
        action={
          <Show when={props.data.editor}>
            {(editor) => (
              <Button type="button" variant="primary" onClick={() => openPanel(editor().provider)}>
                <i class="ti ti-sparkles" aria-hidden="true" />
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
        input: { codeId: props.state.code.id },
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
  const activate = (mode: "waiting" | "again") => {
    const version = mode === "waiting" ? props.state.waiting : props.state.active;
    if (!version) return;
    void openActivationDialog({ data: props.data, state: props.state, version, mode, text: props.text });
  };
  const tabs = () => [
    { id: "overview", label: t().tabOverview, href: props.data.href },
    { id: "runs", label: t().tabRuns, href: withQuery(props.data.href, { tab: "runs" }) },
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
          <p class="cloud-code__lead">{t().actsAs({ name: props.data.owner.title })}</p>
          <VersionLine data={props.data} state={props.state} text={props.text} />
        </div>
        <div class="cloud-code__head-actions">
          <Show when={canSwitchOn()}>
            <Button type="button" variant="primary" onClick={() => activate("waiting")}>
              <i class="ti ti-power" aria-hidden="true" />
              {t().switchOnVersion({ version: props.state.waiting!.number })}
            </Button>
          </Show>
          <Show when={editor() && props.data.editor}>
            {(panel) => (
              <Button type="button" variant="secondary" onClick={() => openPanel(panel().provider)}>
                <i class="ti ti-sparkles" aria-hidden="true" />
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
        <Match when={props.data.tab === "versions"}>
          <Versions data={props.data} state={props.state} text={props.text} onActivate={() => activate("waiting")} />
        </Match>
      </Switch>
    </>
  );
}

function VersionLine(props: { data: CodePageData; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const activation = () => {
    // Only a grant created by switching on this very version names who did it and when; reused grants are older.
    const rows = (props.state.access ?? []).filter((row) => row.activatedAt && row.activatedVersionId === props.state.active?.id);
    return rows.sort((a, b) => (b.activatedAt ?? "").localeCompare(a.activatedAt ?? ""))[0];
  };
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
              <Show when={activation()}>
                {(row) => (
                  <>
                    {" · "}
                    {row().activatedBy
                      ? t().activatedBy({ name: row().activatedBy!.name, date: props.text.date(row().activatedAt!) })
                      : t().activatedOn({ date: props.text.date(row().activatedAt!) })}
                  </>
                )}
              </Show>
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

function Overview(props: { data: CodePageData; state: CodePageReady; text: PageText; onActivate: (mode: "waiting" | "again") => void }) {
  const t = props.text.t;
  const editor = () => props.state.permission === "editor";
  const removed = () => (props.state.access ?? []).filter((row) => row.state === "removed" && !row.target.own);
  const outside = () => (props.state.access ?? []).filter((row) => !row.target.own);
  /** Which automations fail because of one removed target, and which keep running. */
  const affectedText = (key: string): string[] => {
    const automations = (props.state.automations ?? []).filter((automation) => !automation.isNew);
    const affected = automations.filter((automation) => automation.missingTargets.includes(key));
    if (affected.length === 0) return [];
    // Only automations whose last run succeeded are said to keep running; unknown ones are not mentioned.
    const others = automations.filter(
      (automation) => !automation.missingTargets.includes(key) && !automation.accessUnknown && automation.lastRun?.state === "succeeded",
    );
    const proven = affected.filter((automation) => automation.missingProven);
    const needing = affected.filter((automation) => !automation.missingProven);
    const names = (list: CodePageAutomation[]) => list.map((automation) => `„${automation.entrypoint}“`).join(", ");
    return [
      ...(proven.length > 0 ? [t().affectedFailed({ names: names(proven) })] : []),
      ...(needing.length > 0 ? [t().needsThisAccess({ names: names(needing), count: needing.length })] : []),
      ...(others.length > 0 ? [t().othersRunning({ names: names(others), count: others.length })] : []),
    ];
  };
  const allRemoved = () => outside().length > 1 && outside().every((row) => row.state === "removed");
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
                tone="info"
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
              tone="info"
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
                  <Button type="button" size="sm" variant="primary" onClick={() => props.onActivate("waiting")}>
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
      <Show
        when={allRemoved()}
        fallback={
          <For each={removed()}>
            {(row) => (
              <NoticeCard
                tone="warning"
                icon={row.target.deleted ? "ti ti-trash" : "ti ti-alert-triangle"}
                title={
                  row.target.deleted
                    ? t().targetDeletedTitle({ name: props.text.targetName(row.target) })
                    : t().accessRemovedTitle({ name: props.text.targetName(row.target) })
                }
                detail={[
                  row.target.deleted
                    ? t().targetDeletedDescription({ name: props.text.targetName(row.target) })
                    : t().accessRemovedDescription({ name: props.text.targetName(row.target) }),
                  ...affectedText(row.target.key),
                ].join(" ")}
              >
                <Show when={editor() && props.state.active}>
                  <div class="cloud-code__note-actions">
                    <Show when={!row.target.deleted}>
                      <Button type="button" size="sm" variant="secondary" onClick={() => props.onActivate("again")}>
                        <i class="ti ti-power" aria-hidden="true" />
                        {t().switchOnAgain}
                      </Button>
                    </Show>
                    <EditWithPanel data={props.data} t={t()} size="sm" />
                  </div>
                </Show>
              </NoticeCard>
            )}
          </For>
        }
      >
        <NoticeCard
          tone="warning"
          icon="ti ti-lock-off"
          title={t().allAccessRemovedTitle}
          detail={t().allAccessRemovedDescription({ name: props.data.owner.title })}
        >
          <Show when={editor() && props.state.active}>
            <div class="cloud-code__note-actions">
              <Button type="button" size="sm" variant="secondary" onClick={() => props.onActivate("again")}>
                <i class="ti ti-power" aria-hidden="true" />
                {t().switchOnAgain}
              </Button>
            </div>
          </Show>
        </NoticeCard>
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
      <Section id="cloud-code-access" title={t().access} description={t().accessDescription}>
        <Show when={props.state.access} fallback={<InlineError text={t().accessFailed} retry={t().tryAgain} />}>
          {(access) => (
            <Show
              when={access().length > 0}
              fallback={<p class="cloud-code__quiet">{t().accessEmpty({ name: props.data.owner.title })}</p>}
            >
              <ul class="cloud-code__list">
                <For each={access()}>{(row) => <AccessRow row={row} state={props.state} text={props.text} />}</For>
              </ul>
            </Show>
          )}
        </Show>
      </Section>
      <Show when={props.state.internet}>
        {(internet) => <InternetOrigins internet={internet()} state={props.state} text={props.text} />}
      </Show>
      <Section id="cloud-code-pages" title={t().pagesAndRoutes} count={0}>
        <p class="cloud-code__quiet">{t().pagesNone}</p>
      </Section>
    </div>
  );
}

/** Internet origins the Code may reach with its credentials, from the version's reviewed bindings. */
function InternetOrigins(props: { internet: NonNullable<CodePageReady["internet"]>; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  return (
    <Section
      id="cloud-code-internet"
      title={t().internet}
      count={props.internet.origins.length || undefined}
      description={t().internetDescription}
    >
      <Show when={props.internet.origins.length > 0} fallback={<p class="cloud-code__quiet">{t().internetUnbound}</p>}>
        <ul class="cloud-code__list">
          <For each={props.internet.origins}>
            {(origin) => (
              <li
                class="cloud-code__row cloud-code__row--access"
                data-state={props.internet.newOrigins.includes(origin) ? "new" : undefined}
              >
                <span class="cloud-code__kind" aria-hidden="true">
                  <i class="ti ti-world" />
                </span>
                <span class="cloud-code__cell">
                  <Op>{origin}</Op>
                </span>
                <span class="cloud-code__right">
                  <Show when={props.internet.newOrigins.includes(origin)}>
                    <span class="cloud-code__new">{t().newOnSwitchOn({ version: props.state.waiting?.number ?? 0 })}</span>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Section>
  );
}

function ResumeButton(props: { codeId: string; t: CodePageMessages }) {
  const [busy, setBusy] = createSignal(false);
  const resume = async () => {
    setBusy(true);
    const result = await invokeCapabilityWithDataSchema(
      { appId: "core", capabilityId: "code.resume", kind: "action", input: { codeId: props.codeId }, idempotencyKey: crypto.randomUUID() },
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
    if (props.automation.missingTargets.length > 0) return { tone: "warning", label: t().statusAccessMissing };
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
        input: { codeId: props.state.code.id, entrypoint: props.automation.entrypoint, input: null },
        idempotencyKey: crypto.randomUUID(),
      },
      wrapped(StartSchema),
    );
    setStarting(false);
    if (!result.ok) return toast.error(result.error.message);
    toast.success(t().runStarted);
    documentNavigate(withQuery(props.data.href, { tab: "runs", run: result.data.data.data.runId }));
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
          {props.automation.entrypoint}
          <Show when={props.automation.isNew}>
            <Tag>{t().newTag}</Tag>
          </Show>
        </span>
        <span class="cloud-code__sub">{schedule()}</span>
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

function AccessRow(props: { row: CodePageAccessRow; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const right = (): JSX.Element => {
    const row = props.row;
    if (row.state === "new") return <span class="cloud-code__new">{t().newOnSwitchOn({ version: props.state.waiting?.number ?? 0 })}</span>;
    if (row.state === "removed")
      return (
        <span class="cloud-code__bad">
          <i class={row.target.deleted ? "ti ti-trash" : "ti ti-circle-x"} aria-hidden="true" />{" "}
          {row.target.deleted ? t().targetDeleted : t().removed}
        </span>
      );
    if (row.state === "unavailable")
      return (
        <span class="cloud-code__warn">
          <i class="ti ti-plug-connected-x" aria-hidden="true" /> {t().unavailable}
        </span>
      );
    return (
      <span class="text-secondary">
        {row.activatedAt
          ? row.activatedBy
            ? t().activatedBy({ name: row.activatedBy.name, date: props.text.date(row.activatedAt) })
            : t().activatedOn({ date: props.text.date(row.activatedAt) })
          : ""}
        <Show when={row.newOperations.length > 0}>
          <span class="cloud-code__new"> · {t().alsoNew({ operations: row.newOperations.join(", ") })}</span>
        </Show>
      </span>
    );
  };
  return (
    <li
      class="cloud-code__row cloud-code__row--access"
      data-state={props.row.state}
      data-deleted={props.row.target.deleted ? "" : undefined}
    >
      <span class="cloud-code__kind" aria-hidden="true">
        <i class={props.row.target.icon ?? (props.row.target.own ? "ti ti-home" : "ti ti-target-arrow")} />
      </span>
      <span class="cloud-code__cell">
        <span class="cloud-code__ops">
          <For each={props.row.operations}>{(operation) => <Op>{operation}</Op>}</For>
        </span>
        <span class="cloud-code__sub">
          <Show when={props.row.target.href && !props.row.target.own} fallback={props.text.targetLabel(props.row.target)}>
            <a href={props.row.target.href!}>{props.text.targetLabel(props.row.target)}</a>
          </Show>
        </span>
      </span>
      <span class="cloud-code__right">{right()}</span>
    </li>
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
    const result = await browserInvoke(
      coreQuery("code.run.list", { codeId: props.state.code.id, limit: 20, cursor: next }),
      wrapped(RunListSchema),
    );
    setLoading(false);
    if (!result.ok) return setFailed(true);
    const numbers = new Map(props.state.versions.map((version) => [version.id, version.number]));
    setItems([...items(), ...result.data.data.data.items.map((run) => ({ ...run, versionNumber: numbers.get(run.versionId) ?? null }))]);
    setCursor(result.data.data.data.nextCursor);
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
                          {shortId(run.id)} · {run.entrypoint}
                        </span>
                        <span class="cloud-code__sub">
                          {[
                            props.text.when(run.createdAt),
                            triggerLabel(run, t()),
                            run.versionNumber ? t().runVersion({ version: run.versionNumber }) : null,
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
    const result = await loadCodeRunCalls(browserInvoke, props.state.code.id, run().id, after);
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
        input: { codeId: props.state.code.id, entrypoint: run().entrypoint, input: props.detail.input ?? null },
        // One rerun per failed run, also after a lost response or a double click.
        idempotencyKey: `rerun:${run().id}`,
      },
      wrapped(StartSchema),
    );
    setRerunning(false);
    if (!result.ok) return toast.error(t().rerunFailed);
    toast.success(t().rerunStarted);
    documentNavigate(withQuery(props.data.href, { tab: "runs", run: result.data.data.data.runId }));
  };
  const target = (call: CodePageCall) => {
    if (!call.target) return null;
    const known = [
      ...(props.state.access ?? []).map((row) => row.target),
      ...(props.state.waitingTargets ?? []).map((row) => row.target),
    ].find((candidate) => candidate.ref.type === call.target!.type && candidate.ref.id === call.target!.id);
    return known
      ? props.text.targetLabel(known)
      : props.text.targetLabel({
          key: "",
          ref: call.target,
          title: null,
          typeTitle: null,
          icon: null,
          own: false,
          deleted: false,
          href: null,
        });
  };
  return (
    <section class="cloud-code__run-detail" aria-labelledby="cloud-code-run-title">
      <div class="cloud-code__run-head">
        <div class="min-w-0">
          <h2 id="cloud-code-run-title" class="cloud-code__h2">
            {shortId(run().id)} · {run().entrypoint}
          </h2>
          <p class="cloud-code__sub">
            {[
              props.text.when(run().createdAt),
              run().versionNumber ? t().runVersion({ version: run().versionNumber! }) : null,
              triggerLabel(run(), t()),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <StatusBadge tone={runTone(run())} label={runStateLabel(run(), t())} />
      </div>
      <Show when={run().state === "failed"}>
        <Show
          when={afterAction()}
          fallback={
            <Show
              when={beforeFirstAction()}
              fallback={<NoticeCard tone="danger" icon="ti ti-circle-x" title={t().stateFailed} detail={outcomeText() ?? undefined} />}
            >
              <NoticeCard
                tone="danger"
                icon="ti ti-circle-x"
                title={t().failedBeforeFirstTitle}
                detail={[outcomeText(), t().failedBeforeFirst].filter(Boolean).join(". ")}
              />
            </Show>
          }
        >
          <NoticeCard
            tone="danger"
            icon="ti ti-circle-x"
            title={t().failedAfterFirstTitle}
            detail={[outcomeText(), t().failedAfterFirst].filter(Boolean).join(". ")}
          >
            <Show when={canRerun()}>
              <div class="cloud-code__note-actions">
                <Button type="button" size="sm" variant="secondary" loading={rerunning()} onClick={() => void rerun()}>
                  <i class="ti ti-repeat" aria-hidden="true" />
                  {t().rerun}
                </Button>
              </div>
            </Show>
          </NoticeCard>
        </Show>
      </Show>
      <Show when={run().state !== "failed" && run().outcome && run().outcome !== "succeeded"}>
        <p class="cloud-code__quiet">{t().outcome({ code: run().outcome! })}</p>
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

/** "Switch on": lists every operation at every target, then runs Core's durable activation and shows its result. */
async function openActivationDialog(params: {
  data: CodePageData;
  state: CodePageReady;
  version: CodePageVersion;
  mode: "waiting" | "again";
  text: PageText;
}) {
  const t = params.text.t();
  await prompts.dialog<void>((close) => <ActivationDialog {...params} close={() => close()} />, {
    title: params.mode === "waiting" ? t.activateTitle({ version: params.version.number }) : t.switchOnAgain,
    icon: "ti ti-power",
    size: "large",
  });
}

function ActivationDialog(props: {
  data: CodePageData;
  state: CodePageReady;
  version: CodePageVersion;
  mode: "waiting" | "again";
  text: PageText;
  close: () => void;
}) {
  const t = props.text.t;
  const [view, setView] = createSignal<ActivationView>({ kind: "idle" });
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const running = () => (props.mode === "waiting" ? (props.state.active?.number ?? null) : null);
  const rows = (): CodePageActivationRow[] =>
    props.mode === "waiting"
      ? (props.state.waitingTargets ?? [])
      : (props.state.access ?? []).map((row) => ({ target: row.target, operations: row.operations, isNew: row.state === "removed" }));
  const failedTarget = () => {
    const current = view();
    return current.kind === "failed" ? current.failure?.target : null;
  };
  const newAutomations = () =>
    props.mode === "waiting"
      ? (props.state.automations ?? []).filter((automation) => automation.isNew).map((automation) => `„${automation.entrypoint}“`)
      : [];
  const blocked = () => {
    const current = view();
    return current.kind === "failed" && current.failure?.code === "not_manager";
  };
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
  const targetByRef = (ref: { type: string; id: string } | null | undefined) =>
    ref ? (rows().find((row) => row.target.ref.type === ref.type && row.target.ref.id === ref.id)?.target ?? null) : null;
  const rowRight = (row: CodePageActivationRow): JSX.Element => {
    const failed = failedTarget();
    if (blocked() && failed && failed.type === row.target.ref.type && failed.id === row.target.ref.id)
      return (
        <span class="cloud-code__bad">
          <i class="ti ti-lock" aria-hidden="true" /> {t().notAdmin}
        </span>
      );
    if (row.target.own && props.data.canManageOwner)
      return (
        <span class="cloud-code__ok">
          <i class="ti ti-check" aria-hidden="true" /> {t().youManage({ name: props.data.owner.title })}
        </span>
      );
    if (!row.isNew)
      return <span class="text-dimmed">{t().alreadyHas({ version: props.state.active?.number ?? props.version.number })}</span>;
    return <span class="text-secondary">{t().checkedAtTarget}</span>;
  };
  /**
   * Whether the person may read the refusing target: its own reader named it for them while the page loaded. Only then
   * does the message name it and who manages it; otherwise only its ID, whatever the refusal carries.
   */
  const blockedReadable = () => {
    const current = view();
    if (current.kind !== "failed" || !current.failure?.target) return false;
    const target = targetByRef(current.failure.target);
    return Boolean(target && (target.own || (target.title !== null && !target.deleted)));
  };
  const managersText = () => {
    const current = view();
    const names = current.kind === "failed" && blockedReadable() ? (current.failure?.managers ?? []).map((manager) => manager.name) : [];
    return names.length > 0 ? t().managedBy({ names: names.join(", ") }) : "";
  };
  const failureText = (): string | null => {
    const current = view();
    if (current.kind !== "failed") return null;
    if (!current.failure) return current.message ?? t().activationUnavailable;
    const target = targetByRef(current.failure.target);
    const name = target ? props.text.targetName(target) : (current.failure.target?.id ?? props.data.owner.title);
    if (current.failure.code === "not_manager")
      return blockedReadable()
        ? t().blockedNotAdmin({ target: name, owner: props.data.owner.title })
        : t().blockedNotAdminUnreadable({ id: current.failure.target?.id ?? "" });
    if (current.failure.code === "removed") return t().accessRemovedAtTarget({ target: name });
    return t().failedGeneric({ reason: current.failure.reason });
  };
  const progressText = () => {
    const current = view();
    if (current.kind === "unknown") return t().activationUnknown({ running: running() });
    if (current.kind !== "progress") return null;
    if (current.state === "waiting") return t().waitingTarget({ running: running() });
    if (current.state === "applying" || current.state === "rolling_back") return t().applying;
    return t().checking;
  };
  const busy = () => view().kind === "progress";
  return (
    <div class="cloud-code__dialog">
      <p>
        {props.mode === "waiting"
          ? t().activateIntro({ name: props.data.owner.title })
          : t().reactivateIntro({ name: props.data.owner.title })}
      </p>
      <p class="cloud-code__label">{t().operationAtTarget}</p>
      <ul class="cloud-code__list">
        <For each={rows()}>
          {(row) => (
            <li
              class="cloud-code__row cloud-code__row--access"
              data-blocked={
                blocked() && failedTarget()?.type === row.target.ref.type && failedTarget()?.id === row.target.ref.id ? "" : undefined
              }
            >
              <span class="cloud-code__kind" aria-hidden="true">
                <i class={row.target.icon ?? (row.target.own ? "ti ti-home" : "ti ti-target-arrow")} />
              </span>
              <span class="cloud-code__cell">
                <span class="cloud-code__ops">
                  <For each={row.operations}>{(operation) => <Op>{operation}</Op>}</For>
                </span>
                <span class="cloud-code__sub">
                  {props.text.targetLabel(row.target)}
                  <Show when={row.isNew}> · {t().newAccess}</Show>
                </span>
              </span>
              <span class="cloud-code__right">{rowRight(row)}</span>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.mode === "waiting" && (props.state.internet?.newOrigins.length ?? 0) > 0}>
        <p class="cloud-code__label">{t().internet}</p>
        <ul class="cloud-code__list">
          <For each={props.state.internet?.newOrigins ?? []}>
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
          <a href={withQuery(props.data.href, { tab: "versions", version: props.version.id })}>{t().showDiff}</a>
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
            icon={blocked() ? "ti ti-lock" : "ti ti-alert-triangle"}
            title={failure()}
            detail={[blocked() ? managersText() : "", t().nothingChanged({ running: running() }), blocked() ? t().shareLink : ""]
              .filter(Boolean)
              .join(" ")}
            role="alert"
          />
        )}
      </Show>
      <div class="cloud-code__dialog-actions">
        <Show when={blocked()}>
          <Button type="button" variant="secondary" onClick={() => void copyPageLink(props.data, t())}>
            <i class="ti ti-link" aria-hidden="true" />
            {t().copyLink}
          </Button>
        </Show>
        <Button type="button" variant="secondary" onClick={() => props.close()}>
          {view().kind === "idle" ? t().cancel : t().close}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!props.data.activation.allowed || blocked() || busy()}
          loading={busy() && view().kind === "progress" && (view() as { state: string }).state !== "waiting"}
          onClick={() => void (view().kind === "unknown" ? check() : start())}
        >
          <i class="ti ti-power" aria-hidden="true" />
          {blocked()
            ? t().switchOn
            : view().kind === "unknown"
              ? t().checkStatus
              : view().kind === "failed"
                ? t().tryAgain
                : props.mode === "waiting"
                  ? t().switchOnVersion({ version: props.version.number })
                  : t().switchOnAgain}
        </Button>
      </div>
    </div>
  );
}
