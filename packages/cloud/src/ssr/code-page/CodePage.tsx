import { refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, Dropdown, type DropdownItem, Placeholder, prompts, Skeleton, toast, ViewTabs } from "@k2b/ui";
import { createSignal, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { z } from "zod";
import { openPanel } from "../../browser/panel";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import { CodeActivityReadModelSchema } from "../../contracts/code-read-model";
import { openActivationDialog } from "./CodeActivation";
import { CodeLaunch } from "./CodeLaunch";
import { type CodeLive, type CodeLiveFeed, createCodeLive } from "./CodeLiveStrip";
import { CodeLede, CodeOverview, lastFinishedRun } from "./CodeOverview";
import { copyHandle } from "./CodeRefusalNotice";
import { CodeRuns, Failed } from "./CodeRuns";
import { CodeSecretsTab } from "./CodeSecrets";
import { CodeSourceTab } from "./CodeSourceTab";
import { CodeVersions } from "./CodeVersions";
import { followCodeRuns } from "./code-live";
import type { CodePageData, CodePageInvoke, CodePageReady } from "./data";
import { launchPages, runnable } from "./launch";
import type { CodePageMessages } from "./messages";
import { Island, type PageText, personal, Row, type Tone, usePageText, withQuery } from "./page-kit";
import { nameRecentResults, recentResultKey } from "./recent-names";
import { createRunAction } from "./run-action";

export { switchOnReady } from "./CodeActivation";
export { CodeDatabaseDelete, CodeDatabaseStatus } from "./CodeDatabaseStatus";
export type { CodeLiveEffect, CodeLiveFeed, CodeLiveRun } from "./CodeLiveStrip";
export { CodeNavStatus, codeNavAttentionLabel } from "./CodeNavStatus";
export type { CodeAttention, CodePageData, CodePageTab } from "./data";

/** Pause and resume return only the new state; the page reloads to show it. */
const ChangedSchema = z.object({ state: z.string() });

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

/** The command that fetches this automation's source; the page itself never shows source outside the code tab. */
const pullCommand = (data: CodePageData) =>
  data.owner.ref ? `cld code pull ${data.owner.ref.type.split(".")[0]}/${data.owner.ref.id}` : "cld code pull";

const openPull = (data: CodePageData, t: CodePageMessages) =>
  void prompts.dialog<void>(
    (close) => (
      <div class="cloud-code__dialog">
        <p>{t.pullIntro}</p>
        <p class="cloud-code__command">
          <code>{pullCommand(data)}</code>
        </p>
        <div class="cloud-code__dialog-actions">
          <Button type="button" variant="secondary" onClick={() => close()}>
            {t.close}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(pullCommand(data));
                toast.success(t.commandCopied);
              } catch {
                toast.error(t.commandCopyFailed);
              }
            }}
          >
            <i class="ti ti-copy" aria-hidden="true" />
            {t.pullCopy}
          </Button>
        </div>
      </div>
    ),
    { title: t.pullSource, icon: "ti ti-terminal-2" },
  );

/**
 * The shared Code page of one place or of one person's own Code: its state in words, the last runs, what it may do,
 * its versions and secrets. No source except in the editor-only code tab. Hosts add their own part below the overview
 * through `footer` (Mail: "Fetch existing mails"), and connect live run updates through `onLive`.
 */
export default function CodePage(props: {
  data: CodePageData;
  /** Shown at the end of the overview, such as the owner app's link to apply the automation to what already exists. */
  footer?: JSX.Element;
  /** Called once in the browser with the page's live feed; return a disposer. The page itself never polls. */
  onLive?: (feed: CodeLiveFeed) => (() => void) | undefined;
}) {
  const text = usePageText(() => props.data);
  const t = text.t;
  return (
    <div class="cloud-code" data-tab={props.data.tab}>
      <Switch>
        <Match when={props.data.state.kind === "error"}>
          <PlainHead data={props.data} text={text} />
          <Failed title={personal(props.data) ? t().personalFailed : t().pageFailed} detail={t().loadKeeps} />
        </Match>
        <Match when={props.data.state.kind === "loading"}>
          <CodePageSkeleton data={props.data} text={text} />
        </Match>
        <Match when={props.data.state.kind === "no-access"}>
          <PlainHead data={props.data} text={text} />
          <Placeholder
            state="no-access"
            variant="panel"
            icon="ti ti-lock"
            title={t().noAccessTitle}
            description={personal(props.data) ? t().personalNoAccessDescription : t().noAccessDescription({ name: props.data.owner.title })}
          />
        </Match>
        <Match when={props.data.state.kind === "none"}>
          <PlainHead data={props.data} text={text} />
          <Placeholder
            variant="panel"
            icon="ti ti-code"
            title={t().emptyCodeTitle({ name: props.data.owner.title })}
            description={t().emptyCodeText({ editor: props.data.canManageOwner ? (props.data.editor?.label ?? null) : null })}
            action={
              <Show when={props.data.canManageOwner && props.data.editor}>
                {(editor) => (
                  <Button type="button" variant="primary" onClick={() => openPanel(editor().provider)}>
                    <i class={editor().icon} aria-hidden="true" />
                    {t().createWith({ name: editor().label })}
                  </Button>
                )}
              </Show>
            }
          />
        </Match>
        <Match when={props.data.state.kind === "ready" && (props.data.state as CodePageReady)}>
          {(state) => <ReadyPage data={props.data} state={state()} text={text} footer={props.footer} onLive={props.onLive} />}
        </Match>
      </Switch>
    </div>
  );
}

/** The head of a page without a loaded automation: its place, quietly. */
function PlainHead(props: { data: CodePageData; text: PageText }) {
  return (
    <header class="cloud-code__head">
      <div class="cloud-code__head-text">
        <h1 class="cloud-code__title">
          {personal(props.data) ? props.data.owner.title || props.text.t().personalPlace : props.text.t().tabCode}
        </h1>
        <Show when={!personal(props.data)}>
          <p class="cloud-code__meta">{place(props.data, props.text)}</p>
        </Show>
      </div>
    </header>
  );
}

/** "Mailbox info@…", "Your Code", "Code of Lea Muster": where the automation belongs. */
const place = (data: CodePageData, text: PageText) => {
  const t = text.t();
  if (!personal(data)) return [data.owner.typeTitle, data.owner.title].filter(Boolean).join(" ");
  if (!data.owner.runsAs) return t.personalPlace;
  return data.owner.runsAs.name ? t.personalPlaceOf({ name: data.owner.runsAs.name }) : t.personalPlaceShared;
};

/** The automation's state in one large word with its sign and colour (Bild 19, 21). */
const bigState = (
  state: CodePageReady,
  t: CodePageMessages,
  last: { state: string } | null | undefined = lastFinishedRun(state),
): { tone: Tone; icon: string; label: string } => {
  if (state.code.state === "paused") return { tone: "warn", icon: "ti ti-player-pause", label: t.statePaused };
  if (state.code.state === "deleting") return { tone: "muted", icon: "ti ti-trash", label: t.stateDeleting };
  if (state.code.state !== "active" || !state.active) return { tone: "muted", icon: "ti ti-circle-dashed", label: t.stateOff };
  if (last?.state === "failed") return { tone: "danger", icon: "ti ti-alert-circle", label: t.stateNeedsYou };
  return { tone: "ok", icon: "ti ti-circle-check", label: t.stateOn };
};

/**
 * Default live wiring: Core's run hints move the strip; a finished run reads the week's effects once, so a new one
 * slides in. One read per finished run and open page; the server checks access per subscription, never per event.
 */
/** At most one read of the week's effects per page in this window. */
const EFFECT_REFRESH_GAP_MS = 30_000;
/** The browser reads with the person's own session, the same rights the server used for the first names. */
const browserInvoke: CodePageInvoke = (invocation, schema) => invokeCapabilityWithDataSchema(invocation, schema);
const followLive = (data: CodePageData, state: CodePageReady, live: CodeLive): (() => void) => {
  const feed = live.feed;
  const timeZone = data.dates.timeZone ?? "UTC";
  const refreshEffects = async () => {
    if (!state.words?.activity) return;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const read = await invokeCapabilityWithDataSchema(
      { appId: "core", capabilityId: "code.activity.words", kind: "query", input: { codeId: state.code.id, day, timeZone } },
      CodeActivityReadModelSchema,
    ).catch(() => null);
    if (!read?.ok) return;
    const known = new Set(live.effects().map(recentResultKey));
    const fresh = read.data.data.recent.filter((effect) => !known.has(recentResultKey(effect)));
    // Only the new results are named, each by its target's reader with this person's rights.
    const named = await nameRecentResults(fresh, browserInvoke, (type) => state.recentReaders?.[type] ?? null);
    // Oldest first, so the newest effect ends on top.
    for (const effect of named.reverse()) feed.effect(effect);
  };
  // Coalesced: the first finished run reads at once, every further one within the window joins one trailing read, so a
  // busy automation costs one read per window and page, never one per run (DATA-13).
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const effects = () => {
    if (!state.words?.activity || timer) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        last = Date.now();
        void refreshEffects();
      },
      Math.max(0, last + EFFECT_REFRESH_GAP_MS - Date.now()),
    );
  };
  const stop = followCodeRuns(
    state.code.id,
    (event) => {
      feed.run({ id: event.runId, state: event.state, createdAt: event.at, ...(event.state === "running" ? { startedAt: event.at } : {}) });
      if (event.state === "succeeded" || event.state === "failed") effects();
    },
    // A gap in the live stream: the page loads its state again instead of guessing.
    () => refreshCurrentPath(),
    state.liveCursor ?? null,
  );
  return () => {
    if (timer) clearTimeout(timer);
    stop();
  };
};

function ReadyPage(props: {
  data: CodePageData;
  state: CodePageReady;
  text: PageText;
  footer?: JSX.Element;
  onLive?: (feed: CodeLiveFeed) => (() => void) | undefined;
}) {
  const t = props.text.t;
  const [currentCode, setCurrentCode] = createSignal(props.state.code);
  const pageState = (): CodePageReady => ({ ...props.state, code: currentCode() });
  const editor = () => pageState().permission === "editor";
  const live = createCodeLive(pageState());
  const run = createRunAction({ data: props.data, state: pageState, live, text: props.text, reconcile: setCurrentCode });
  onMount(() => {
    const stop = props.onLive ? props.onLive(live.feed) : followLive(props.data, pageState(), live);
    if (stop) onCleanup(stop);
  });
  const [busy, setBusy] = createSignal<"pause" | "resume" | null>(null);
  const setPaused = async (paused: boolean) => {
    if (busy()) return;
    setBusy(paused ? "pause" : "resume");
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: paused ? "code.pause" : "code.resume",
        kind: "action",
        target: { type: "core.code", id: pageState().code.id },
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
    const version = pageState().waiting;
    if (!version) return;
    void openActivationDialog({ data: props.data, state: pageState(), version, text: props.text });
  };
  const paused = () => pageState().code.state === "paused";
  const tabs = () => [
    { id: "overview", label: t().tabOverview, href: props.data.href },
    { id: "runs", label: t().tabRuns, href: withQuery(props.data.href, { tab: "runs" }) },
    ...(editor()
      ? [
          {
            id: "secrets",
            label: t().tabSecrets,
            href: withQuery(props.data.href, { tab: "secrets" }),
            count: pageState().secretNames?.length ?? undefined,
          },
        ]
      : []),
    {
      id: "versions",
      label: t().tabVersions,
      href: withQuery(props.data.href, { tab: "versions" }),
      count: pageState().versions.length ? `${pageState().versions.length}${pageState().moreVersions ? "+" : ""}` : undefined,
    },
    // The code is for the people who may change the automation (F30); others see four tabs.
    ...(editor() ? [{ id: "code", label: t().tabCode, href: withQuery(props.data.href, { tab: "code" }) }] : []),
  ];
  const menu = (): DropdownItem[] => [
    ...(editor() && pageState().code.state === "active"
      ? [{ label: t().pause, icon: "ti ti-player-pause", action: () => void setPaused(true), disabled: busy() !== null }]
      : []),
    ...(editor() && paused()
      ? [{ label: t().resume, icon: "ti ti-player-play", action: () => void setPaused(false), disabled: busy() !== null }]
      : []),
    ...(pageState().code.serviceAccountHandle
      ? [{ label: t().copyHandle, icon: "ti ti-id-badge-2", action: () => void copyHandle(pageState().code.serviceAccountHandle!, t()) }]
      : []),
    { label: t().copyLink, icon: "ti ti-link", action: () => void copyPageLink(props.data, t()) },
    // Source is for editors only (F30); readers get no command that names it.
    ...(editor() ? [{ label: t().pullSource, icon: "ti ti-terminal-2", action: () => openPull(props.data, t()) }] : []),
  ];
  const state = () =>
    bigState(
      pageState(),
      t(),
      live.runs().find((run) => run.state === "succeeded" || run.state === "failed"),
    );
  const meta = () => {
    const active = pageState().active;
    const code = pageState().code;
    if (paused())
      return code.pausedAt
        ? t().headPausedOn({ version: active?.number ?? null, date: props.text.short(code.pausedAt) })
        : t().headPaused({ version: active?.number ?? null });
    if (!active) return t().headNoVersion;
    // When and by whom the running version was switched on (Bild 19); older Core answers name its author instead.
    if (code.activatedAt)
      return t().headActivated({ version: active.number, date: props.text.short(code.activatedAt), name: code.activatedBy?.name ?? null });
    return t().headVersion({ version: active.number, name: active.createdBy?.name ?? null, date: props.text.short(active.createdAt) });
  };
  const waitingAction = () => !!pageState().waiting && ["submitted", "approved"].some((status) => status === pageState().waiting!.status);
  const needsYou = () => state().tone === "danger";
  const hasLaunch = () =>
    pageState().code.state === "active" &&
    pageState().automations !== null &&
    !!pageState().active &&
    (launchPages(pageState()).length > 0 || runnable(pageState()).length > 0);
  const changeFilled = () => !paused() && !waitingAction() && (needsYou() || !hasLaunch());
  return (
    <>
      <header class="cloud-code__head">
        <div class="cloud-code__head-text">
          <h1 class="cloud-code__title">
            <Show when={personal(props.data)} fallback={<span class="sr-only">{t().pageOf({ name: props.data.owner.title })}: </span>}>
              <span class="cloud-code__name" title={props.data.owner.title}>
                {props.data.owner.title}
              </span>
            </Show>
            <span class="cloud-code__state" data-tone={state().tone}>
              <span>
                <i class={state().icon} aria-hidden="true" />
                {state().label}
              </span>
              <span class="cloud-code__state-reserve" aria-hidden="true">
                <i class="ti ti-alert-circle" />
                {t().stateNeedsYou}
              </span>
            </span>
          </h1>
          <p class="cloud-code__meta">
            {place(props.data, props.text)} · {meta()}
          </p>
        </div>
        <div class="cloud-code__head-actions">
          <CodeLaunch state={pageState()} text={props.text} run={run} secondary={needsYou() || waitingAction()} />
          <Show when={editor() && paused()}>
            <Button
              type="button"
              variant="primary"
              class="cloud-code__launch"
              loading={busy() === "resume"}
              onClick={() => void setPaused(false)}
            >
              <i class="ti ti-player-play" aria-hidden="true" />
              {t().resume}
            </Button>
          </Show>
          <Show when={editor() && props.data.editor}>
            {(panel) => {
              const content = () => (
                <>
                  <i class={panel().icon} aria-hidden="true" />
                  <span class="cloud-code__change-full">{t().changeWith({ name: panel().label })}</span>
                  <span class="cloud-code__change-short" aria-hidden="true">
                    {t().changeShort}
                  </span>
                </>
              );
              // One filled action in the head: Gustav, unless a waiting version or "Resume" takes that place.
              return (
                <Button
                  type="button"
                  variant={changeFilled() ? "primary" : "secondary"}
                  class={`cloud-code__change${!hasLaunch() && !paused() ? " cloud-code__change--alone" : ""}`}
                  aria-label={t().changeWith({ name: panel().label })}
                  onClick={() => openPanel(panel().provider)}
                >
                  {content()}
                </Button>
              );
            }}
          </Show>
          <Dropdown.Root items={menu()} label={t().more} position="bottom-right" phone="sheet">
            <Dropdown.Trigger iconOnly type="button" variant="ghost" label={t().more} aria-busy={busy() ? "true" : undefined}>
              <i class={busy() ? "ti ti-loader-2 animate-spin" : "ti ti-dots"} aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
        <Show when={paused() && !editor() && launchPages(pageState()).length}>
          <p class="cloud-code__paused-reason">{t().pagesPaused}</p>
        </Show>
      </header>
      <ViewTabs label={t().tabsLabel} items={tabs()} current={props.data.tab} max={5} class="cloud-code__tabs" />
      <Switch>
        <Match when={props.data.tab === "overview"}>
          <CodeLede state={pageState()} text={props.text} />
          <CodeOverview
            data={props.data}
            state={pageState()}
            text={props.text}
            live={live}
            run={run}
            onActivate={activate}
            footer={paused() ? undefined : props.footer}
          />
        </Match>
        <Match when={props.data.tab === "runs"}>
          <CodeRuns data={props.data} state={pageState()} text={props.text} live={live} />
        </Match>
        <Match when={props.data.tab === "secrets"}>
          <CodeSecretsTab data={props.data} state={pageState()} />
        </Match>
        <Match when={props.data.tab === "versions"}>
          <CodeVersions data={props.data} state={pageState()} text={props.text} onActivate={activate} />
        </Match>
        <Match when={props.data.tab === "code"}>
          <Show when={pageState().sourceTab} fallback={<Failed title={t().partFailed} detail={t().loadKeeps} />}>
            {(source) => (
              <CodeSourceTab
                data={source()}
                codeId={pageState().code.id}
                href={withQuery(props.data.href, { tab: "code" })}
                versionsHref={withQuery(props.data.href, { tab: "versions" })}
                dates={props.data.dates}
              />
            )}
          </Show>
        </Match>
      </Switch>
    </>
  );
}

/** The page while it loads (Bild 33): placeholders at the heights of the content they stand for. */
export function CodePageSkeleton(props: { data: CodePageData; text: PageText }) {
  const t = props.text.t;
  const rows = (count: number, timed = false) => (
    <ul class="cloud-code__rows" data-plain={timed ? undefined : ""}>
      {Array.from({ length: count }, () => (
        <Row
          icon="ti ti-clock"
          tile="neutral"
          title={<Skeleton class="cloud-code__skel-line" />}
          sub={<Skeleton class="cloud-code__skel-sub" />}
          trail={
            timed ? (
              <>
                <Skeleton class="cloud-code__skel-status" />
                <Skeleton class="cloud-code__skel-label" />
              </>
            ) : undefined
          }
        />
      ))}
    </ul>
  );
  // The tabs and island titles are known before the data: they stand as they will, so nothing moves when it loads.
  const tabs = () => [
    { id: "overview", label: t().tabOverview, href: props.data.href },
    { id: "runs", label: t().tabRuns, href: withQuery(props.data.href, { tab: "runs" }) },
    ...(props.data.canManageOwner ? [{ id: "secrets", label: t().tabSecrets, href: withQuery(props.data.href, { tab: "secrets" }) }] : []),
    { id: "versions", label: t().tabVersions, href: withQuery(props.data.href, { tab: "versions" }) },
    ...(props.data.canManageOwner ? [{ id: "code", label: t().tabCode, href: withQuery(props.data.href, { tab: "code" }) }] : []),
  ];
  return (
    <div class="cloud-code__skeleton" role="status" aria-busy="true" aria-label={t().loadingPage}>
      <header class="cloud-code__head">
        <div class="cloud-code__head-text">
          <div class="cloud-code__skel-heading" aria-hidden="true">
            <h1 class="cloud-code__title">
              <Show when={personal(props.data)}>
                <span class="cloud-code__name" title={props.data.owner.title}>
                  {props.data.owner.title}
                </span>
              </Show>
              <span class="cloud-code__state">
                <span>
                  <i class="ti ti-circle-check" />
                  {t().stateOn}
                </span>
                <span class="cloud-code__state-reserve">
                  <i class="ti ti-alert-circle" />
                  {t().stateNeedsYou}
                </span>
              </span>
            </h1>
            <Skeleton class="cloud-code__skel-title" />
          </div>
          <Skeleton class="cloud-code__skel-meta" />
        </div>
        <div class="cloud-code__head-actions" aria-hidden="true">
          <Skeleton class="cloud-code__skel-actions" />
        </div>
      </header>
      <ViewTabs label={t().tabsLabel} items={tabs()} current={props.data.tab} max={5} class="cloud-code__tabs" />
      <span class="cloud-code__skel-lede-block">
        <Skeleton class="cloud-code__skel-lede" />
        <Skeleton class="cloud-code__skel-lede cloud-code__skel-line--short" />
      </span>
      <div class="cloud-code__lage cloud-code__lage--skeleton">
        <span class="cloud-code__lage-cell">
          <Skeleton class="cloud-code__skel-label" />
          <Skeleton class="cloud-code__skel-big" />
        </span>
        <span class="cloud-code__lage-cell">
          <Skeleton class="cloud-code__skel-label" />
          <Skeleton class="cloud-code__skel-last" />
        </span>
        <span class="cloud-code__runs">
          <Skeleton class="cloud-code__skel-label" />
          <Skeleton class="cloud-code__skel-strip" />
          <Skeleton class="cloud-code__skel-label" />
        </span>
      </div>
      <div class="cloud-code__grid">
        <div class="cloud-code__stack">
          <Show when={!personal(props.data)}>
            <Island title={t().didTitle} class="cloud-code__o0">
              <div class="cloud-code__skel-counts">
                <Skeleton class="cloud-code__skel-big" />
                <Skeleton class="cloud-code__skel-big" />
              </div>
              {rows(4)}
            </Island>
          </Show>
          <Island
            title={t().whenTitle}
            class="cloud-code__o1 cloud-code__when"
            actions={props.data.canManageOwner ? <Skeleton class="cloud-code__skel-run-now" /> : undefined}
          >
            {rows(personal(props.data) ? 1 : 2, true)}
          </Island>
        </div>
        <div class="cloud-code__stack">
          <Island title={t().mayTitle} class="cloud-code__o2 cloud-code__may">
            {rows(3)}
            <p class="cloud-code__foot">
              <Skeleton class="cloud-code__skel-label" />
            </p>
          </Island>
        </div>
      </div>
    </div>
  );
}
