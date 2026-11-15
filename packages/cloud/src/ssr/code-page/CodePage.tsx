import { refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, Dropdown, type DropdownItem, Placeholder, prompts, Skeleton, toast, ViewTabs } from "@k2b/ui";
import { createSignal, type JSX, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { z } from "zod";
import { openPanel } from "../../browser/panel";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import { CodeActivityReadModelSchema } from "../../contracts/code-read-model";
import { openActivationDialog } from "./CodeActivation";
import { type CodeLive, type CodeLiveFeed, createCodeLive } from "./CodeLiveStrip";
import { CodeLede, CodeOverview, lastFinishedRun } from "./CodeOverview";
import { copyHandle } from "./CodeRefusalNotice";
import { CodeRuns, Failed } from "./CodeRuns";
import { CodeSecretsTab } from "./CodeSecrets";
import { CodeSourceTab } from "./CodeSourceTab";
import { CodeVersions } from "./CodeVersions";
import { followCodeRuns } from "./code-live";
import type { CodePageData, CodePageReady } from "./data";
import type { CodePageMessages } from "./messages";
import { type PageText, personal, type Tone, usePageText, withQuery } from "./page-kit";

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
const bigState = (state: CodePageReady, t: CodePageMessages): { tone: Tone; icon: string; label: string } => {
  if (state.code.state === "paused") return { tone: "warn", icon: "ti ti-player-pause", label: t.statePaused };
  if (state.code.state === "deleting") return { tone: "muted", icon: "ti ti-trash", label: t.stateDeleting };
  if (state.code.state !== "active" || !state.active) return { tone: "muted", icon: "ti ti-circle-dashed", label: t.stateOff };
  if (lastFinishedRun(state)?.state === "failed") return { tone: "danger", icon: "ti ti-alert-circle", label: t.stateNeedsYou };
  return { tone: "ok", icon: "ti ti-circle-check", label: t.stateOn };
};

/**
 * Default live wiring: Core's run hints move the strip; a finished run reads the week's effects once, so a new one
 * slides in. One read per finished run and open page; the server checks access per subscription, never per event.
 */
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
    // Oldest first, so the newest effect ends on top.
    if (!read?.ok) return;
    const known = new Set(live.effects().map((effect) => `${effect.runId}:${effect.text}`));
    for (const effect of [...read.data.data.recent].reverse()) if (!known.has(`${effect.runId}:${effect.text}`)) feed.effect(effect);
  };
  return followCodeRuns(state.code.id, (event) => {
    feed.run({ id: event.runId, state: event.state, createdAt: event.at });
    if (event.state === "succeeded" || event.state === "failed") void refreshEffects();
  });
};

function ReadyPage(props: {
  data: CodePageData;
  state: CodePageReady;
  text: PageText;
  footer?: JSX.Element;
  onLive?: (feed: CodeLiveFeed) => (() => void) | undefined;
}) {
  const t = props.text.t;
  const editor = () => props.state.permission === "editor";
  const live = createCodeLive(props.state);
  onMount(() => {
    const stop = props.onLive ? props.onLive(live.feed) : followLive(props.data, props.state, live);
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
  const paused = () => props.state.code.state === "paused";
  const tabs = () => [
    { id: "overview", label: t().tabOverview, href: props.data.href },
    { id: "runs", label: t().tabRuns, href: withQuery(props.data.href, { tab: "runs" }) },
    ...(editor()
      ? [
          {
            id: "secrets",
            label: t().tabSecrets,
            href: withQuery(props.data.href, { tab: "secrets" }),
            count: props.state.secretNames?.length ?? undefined,
          },
        ]
      : []),
    {
      id: "versions",
      label: t().tabVersions,
      href: withQuery(props.data.href, { tab: "versions" }),
      count: props.state.versions.length ? `${props.state.versions.length}${props.state.moreVersions ? "+" : ""}` : undefined,
    },
    // The code is for the people who may change the automation (F30); others see four tabs.
    ...(editor() ? [{ id: "code", label: t().tabCode, href: withQuery(props.data.href, { tab: "code" }) }] : []),
  ];
  const menu = (): DropdownItem[] => [
    ...(editor() && props.state.code.state === "active"
      ? [{ label: t().pause, icon: "ti ti-player-pause", action: () => void setPaused(true), disabled: busy() !== null }]
      : []),
    ...(editor() && paused()
      ? [{ label: t().resume, icon: "ti ti-player-play", action: () => void setPaused(false), disabled: busy() !== null }]
      : []),
    ...(props.state.code.serviceAccountHandle
      ? [{ label: t().copyHandle, icon: "ti ti-id-badge-2", action: () => void copyHandle(props.state.code.serviceAccountHandle!, t()) }]
      : []),
    { label: t().copyLink, icon: "ti ti-link", action: () => void copyPageLink(props.data, t()) },
    { label: t().pullSource, icon: "ti ti-terminal-2", action: () => openPull(props.data, t()) },
  ];
  const state = () => bigState(props.state, t());
  const meta = () => {
    const active = props.state.active;
    if (paused()) return t().headPaused({ version: active?.number ?? null });
    if (!active) return t().headNoVersion;
    return t().headVersion({ version: active.number, name: active.createdBy?.name ?? null, date: props.text.short(active.createdAt) });
  };
  /** "Change with Gustav" is filled unless a waiting version or "Resume" takes that place. */
  const changeFilled = () => !paused() && !props.state.proposal && !props.state.waiting;
  return (
    <>
      <header class="cloud-code__head">
        <div class="cloud-code__head-text">
          <h1 class="cloud-code__title">
            <Show when={personal(props.data)} fallback={<span class="sr-only">{t().pageOf({ name: props.data.owner.title })}: </span>}>
              <span class="cloud-code__name">{props.data.owner.title}</span>
            </Show>
            <span class="cloud-code__state" data-tone={state().tone}>
              <i class={state().icon} aria-hidden="true" />
              {state().label}
            </span>
          </h1>
          <p class="cloud-code__meta">
            {place(props.data, props.text)} · {meta()}
          </p>
        </div>
        <div class="cloud-code__head-actions">
          <Show when={editor() && paused()}>
            <Button type="button" variant="primary" loading={busy() === "resume"} onClick={() => void setPaused(false)}>
              <i class="ti ti-player-play" aria-hidden="true" />
              {t().resume}
            </Button>
          </Show>
          <Show when={editor() && props.data.editor}>
            {(panel) => {
              const content = () => (
                <>
                  <i class={panel().icon} aria-hidden="true" />
                  {t().changeWith({ name: panel().label })}
                </>
              );
              // One filled action in the head: Gustav, unless a waiting version or "Resume" takes that place.
              return (
                <Show
                  when={changeFilled()}
                  fallback={
                    <Button type="button" variant="secondary" onClick={() => openPanel(panel().provider)}>
                      {content()}
                    </Button>
                  }
                >
                  <Button type="button" variant="primary" onClick={() => openPanel(panel().provider)}>
                    {content()}
                  </Button>
                </Show>
              );
            }}
          </Show>
          <Dropdown.Root items={menu()} label={t().more} position="bottom-right" phone="sheet">
            <Dropdown.Trigger iconOnly type="button" variant="ghost" label={t().more} aria-busy={busy() ? "true" : undefined}>
              <i class={busy() ? "ti ti-loader-2 animate-spin" : "ti ti-dots"} aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
      </header>
      <ViewTabs label={t().tabsLabel} items={tabs()} current={props.data.tab} max={5} class="cloud-code__tabs" />
      <Switch>
        <Match when={props.data.tab === "overview"}>
          <CodeLede state={props.state} text={props.text} />
          <CodeOverview
            data={props.data}
            state={props.state}
            text={props.text}
            live={live}
            onActivate={activate}
            footer={paused() ? undefined : props.footer}
          />
        </Match>
        <Match when={props.data.tab === "runs"}>
          <CodeRuns data={props.data} state={props.state} text={props.text} live={live} />
        </Match>
        <Match when={props.data.tab === "secrets"}>
          <CodeSecretsTab data={props.data} state={props.state} />
        </Match>
        <Match when={props.data.tab === "versions"}>
          <CodeVersions data={props.data} state={props.state} text={props.text} onActivate={activate} />
        </Match>
        <Match when={props.data.tab === "code"}>
          <Show when={props.state.sourceTab} fallback={<Failed title={t().partFailed} detail={t().loadKeeps} />}>
            {(source) => (
              <CodeSourceTab
                data={source()}
                codeId={props.state.code.id}
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
  const rows = (count: number) =>
    Array.from({ length: count }, () => (
      <div class="cloud-code__skel-row">
        <Skeleton class="cloud-code__skel-tile" />
        <span>
          <Skeleton class="cloud-code__skel-line" />
          <Skeleton class="cloud-code__skel-line cloud-code__skel-line--short" />
        </span>
      </div>
    ));
  return (
    <div class="cloud-code__skeleton" role="status" aria-busy="true" aria-label={props.text.t().loadingPage}>
      <header class="cloud-code__head">
        <div class="cloud-code__head-text">
          <Skeleton class="cloud-code__skel-title" />
          <Skeleton class="cloud-code__skel-meta" />
        </div>
      </header>
      <Skeleton class="cloud-code__skel-tabs" />
      <Skeleton class="cloud-code__skel-lede" />
      <Show when={!personal(props.data)}>
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
      </Show>
      <div class="cloud-code__grid">
        <div class="cloud-code__stack">
          <Show when={!personal(props.data)}>
            <section class="cloud-code__skel-island">{rows(3)}</section>
          </Show>
          <section class="cloud-code__skel-island">{rows(personal(props.data) ? 1 : 2)}</section>
        </div>
        <div class="cloud-code__stack">
          <section class="cloud-code__skel-island">{rows(3)}</section>
        </div>
      </div>
    </div>
  );
}
