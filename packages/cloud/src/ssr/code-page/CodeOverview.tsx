import { refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, ButtonLink, NoticeCard, Tag, toast } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import { openPanel } from "../../browser/panel";
import { CodeChatMissing, CodeChatRowAction } from "./CodeChatBinding";
import { CodeDatabaseStatus } from "./CodeDatabaseStatus";
import { RunNow } from "./CodeLaunch";
import { type CodeLive, CodeLiveStrip, EffectRows } from "./CodeLiveStrip";
import { CodeVersionApproval } from "./CodeVersionApproval";
import type { CodePageAutomation, CodePageData, CodePageReady } from "./data";
import { opensPage, routeHref, routeTitle, timing } from "./launch";
import { Island, iconClass, ModelMark, type PageText, personal, Row, runStatus, Status, sentence, splitRow, withQuery } from "./page-kit";
import type { CodeRunAction } from "./run-action";

export { timing } from "./launch";

import { targetKey } from "./targets";

/** "When it runs" shows this many triggers before "Show n more". */
const WHEN_ROWS = 6;

/** The next start of any running automation, or null. */
export const nextRunOf = (state: CodePageReady): string | null =>
  (state.automations ?? [])
    .filter((automation) => !automation.isNew && automation.nextRunAt)
    .map((automation) => automation.nextRunAt!)
    .sort()[0] ?? null;

/**
 * Whether a next run is known: `none` only when Core says nothing is planned; when it cannot say (no scheduler answer,
 * a list that did not load) the page says "not known" instead of claiming that nothing runs.
 */
export const nextRunStateOf = (state: CodePageReady): "planned" | "none" | "unavailable" => {
  if (nextRunOf(state)) return "planned";
  const current = (state.automations ?? []).filter((automation) => !automation.isNew);
  if (!state.automations || current.some((automation) => automation.nextRunState === "unavailable")) return "unavailable";
  return "none";
};

/** The newest run that ended; skipped and cancelled starts are not a result. */
export const lastFinishedRun = (state: CodePageReady) =>
  state.runs?.items.find((run) => run.state === "succeeded" || run.state === "failed") ?? null;

/** The sentence about what the automation does: Gustav's text with its mark, or the read model's restriction. */
export function CodeLede(props: { state: CodePageReady; text: PageText }) {
  const description = () => props.state.words?.current?.description ?? null;
  return (
    <Show
      when={description()?.text}
      fallback={
        // Without a description the place stays, with a quiet line: the page never jumps when one arrives.
        <Show when={props.state.words?.current}>
          <p class="cloud-code__lede cloud-code__lede--missing">{props.text.t().descriptionMissing}</p>
        </Show>
      }
    >
      {(text) => (
        <p class="cloud-code__lede">
          {text()}{" "}
          <Show when={description()?.state === "visible"}>
            <ModelMark label={props.text.t().describedBy({ name: props.text.editorName() })} />
          </Show>
        </p>
      )}
    </Show>
  );
}

/** The last run failed: what happened, what it means, and the one or two next steps (Bild 21). */
function NeedsYou(props: { data: CodePageData; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const run = () => lastFinishedRun(props.state);
  const words = () => (run() ? (props.state.words?.runs[run()!.id] ?? null) : null);
  const refusalHref = () => {
    const refusal = props.state.refusal;
    return refusal?.kind === "target_refused" && refusal.runId === run()?.id ? (refusal.call?.target?.href ?? null) : null;
  };
  const panel = () => (props.state.permission === "editor" ? props.data.editor : null);
  return (
    <Show when={run()?.state === "failed" && props.state.code.state === "active" && run()}>
      {(failed) => (
        <NoticeCard
          tone="danger"
          icon={props.state.refusal ? "ti ti-lock" : "ti ti-alert-circle"}
          layout="card"
          role="alert"
          class="cloud-code__needs-you"
          title={words()?.reason ?? t().lastRunFailed}
          detail={
            words()
              ?.untilThen.items.map((row) => row.text)
              .join(" · ") || undefined
          }
          actions={
            <>
              <Show
                when={refusalHref()}
                fallback={
                  <Show when={panel()}>
                    {(editor) => (
                      <Button type="button" size="sm" variant="secondary" onClick={() => openPanel(editor().provider)}>
                        <i class={editor().icon} aria-hidden="true" />
                        {t().changeWith({ name: editor().label })}
                      </Button>
                    )}
                  </Show>
                }
              >
                {(href) => (
                  <ButtonLink size="sm" variant="secondary" href={href()}>
                    <i class="ti ti-lock" aria-hidden="true" />
                    {t().checkAccess}
                  </ButtonLink>
                )}
              </Show>
              <ButtonLink size="sm" variant="secondary" href={withQuery(props.data.href, { tab: "runs", run: failed().id })}>
                {t().viewRun}
              </ButtonLink>
            </>
          }
        />
      )}
    </Show>
  );
}

/** Counted, confirmed effects of this week and the latest results; never an estimated time saving. */
function Did(props: { state: CodePageReady; live: CodeLive; text: PageText }) {
  const t = props.text.t;
  const activity = () => props.state.words?.activity ?? null;
  const counters = () => (activity()?.counters.items ?? []).slice(0, 2);
  return (
    <Island
      class="cloud-code__did"
      title={t().didTitle}
      meta={t().didWeek}
      state={activity() ? "ready" : "error"}
      errorMessage={t().partFailed}
      onRetry={() => refreshCurrentPath()}
      loadingRows={4}
    >
      <Show when={counters().length > 0 || props.live.effects().length > 0} fallback={<p class="cloud-code__quiet-line">{t().didEmpty}</p>}>
        <Show
          when={counters().length > 0}
          fallback={
            <div class="cloud-code__did-counts">
              <p class="cloud-code__did-counts-none">{t().didNoneThisWeek}</p>
            </div>
          }
        >
          <div class="cloud-code__did-counts">
            <For each={counters()}>
              {(counter) => (
                <div>
                  <b>{new Intl.NumberFormat(props.text.locale()).format(counter.count)}</b>
                  <span>{splitRow(counter.text).head}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <EffectRows live={props.live} text={props.text} />
      </Show>
    </Island>
  );
}

/**
 * A grant's place with its kind, as the registry names the type ("Postfach", "Space"): the kind comes from the page's
 * targets, which read the catalog as the person. A row Core named by its target carries the reference; the owner's own
 * row is known by its name. Without a kind the place stays its name alone.
 */
export const placeText = (
  row: { target?: { ref: { type: string; id: string } } },
  name: string | null,
  state: Pick<CodePageReady, "targets">,
  ownerTitle: string,
): string => {
  if (!name) return "";
  const rows = state.targets ?? [];
  const ref = row.target?.ref;
  const target = ref
    ? rows.find((item) => targetKey(item.target.ref) === targetKey(ref))?.target
    : name === ownerTitle
      ? rows.find((item) => item.target.own)?.target
      : undefined;
  const kind = target?.typeTitle;
  return kind && !name.startsWith(`${kind} `) ? `${kind} ${name}` : name;
};

function When(props: { data: CodePageData; state: CodePageReady; text: PageText; live: CodeLive; run: CodeRunAction }) {
  const t = props.text.t;
  const [all, setAll] = createSignal(false);
  const rows = () => (props.state.automations ?? []).filter((automation) => automation.kind !== "route");
  const shown = () => (all() ? rows() : rows().slice(0, WHEN_ROWS));
  const paused = () => props.state.code.state === "paused";
  const trail = (automation: CodePageAutomation): JSX.Element => {
    if (automation.isNew) return null;
    if (paused()) return <Status tone="warn" icon="ti ti-player-pause" label={t().statePaused} />;
    const run = props.live.runs().find((run) => run.entrypoint === automation.entrypoint) ?? automation.lastRun;
    return (
      <>
        <Show when={run} keyed fallback={<Status tone="muted" icon="ti ti-minus" label={t().whenNever} />}>
          {(last) => (
            <Status
              {...runStatus(last.state, t())}
              label={
                last.state === "queued"
                  ? t().runStarting
                  : last.state === "running"
                    ? t().runCurrentlyRunning
                    : last.state === "failed"
                      ? t().whenFailed({ when: props.text.moment(last.createdAt) })
                      : props.text.moment(last.createdAt)
              }
            />
          )}
        </Show>
        <Show when={automation.nextRunAt}>
          {(next) => <span class="cloud-code__meta">{t().nextRun({ when: props.text.moment(next()) })}</span>}
        </Show>
      </>
    );
  };
  return (
    <Island
      class="cloud-code__when"
      title={t().whenTitle}
      meta={props.state.automations ? String(rows().length) : undefined}
      actions={<RunNow state={props.state} text={props.text} run={props.run} />}
      state={props.state.automations ? "ready" : "error"}
      errorMessage={t().partFailed}
      onRetry={() => refreshCurrentPath()}
      loadingRows={2}
    >
      <Show
        when={rows().length > 0}
        fallback={<p class="cloud-code__quiet-line">{(props.state.automations ?? []).some(opensPage) ? t().whenPages : t().whenEmpty}</p>}
      >
        <ul class="cloud-code__rows">
          <For each={shown()}>
            {(automation) => (
              <Row
                icon={automation.kind === "event" ? "ti ti-bolt" : automation.kind === "manual" ? "ti ti-hand-finger" : "ti ti-clock"}
                tile={automation.kind === "event" ? "event" : "clock"}
                title={sentence(timing(automation, props.text), props.text.locale())}
                after={
                  <Show when={automation.isNew}>
                    <Tag size="sm" class="cloud-code__new-tag">
                      {t().newFrom({ version: props.state.waiting?.number ?? props.state.proposal?.number ?? 0 })}
                    </Tag>
                  </Show>
                }
                sub={automation.title}
                trail={trail(automation)}
              />
            )}
          </For>
        </ul>
        <Show when={!all() && rows().length > WHEN_ROWS}>
          <button type="button" class="cloud-code__more" onClick={() => setAll(true)}>
            <i class="ti ti-chevron-down" aria-hidden="true" />
            {t().showMore({ count: rows().length - WHEN_ROWS })}
          </button>
        </Show>
      </Show>
    </Island>
  );
}

const hostOf = (origin: string) => {
  try {
    const url = new URL(origin);
    return url.host;
  } catch {
    return origin;
  }
};

/** Apps, the internet and its own data in one list: each right with its app, a sentence, and where it applies. */
function MayDo(props: { data: CodePageData; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const words = () => props.state.words?.current ?? null;
  const origins = () => props.state.internet.active ?? props.state.internet.waiting ?? [];
  const list = (items: string[]) => new Intl.ListFormat(props.text.locale(), { type: "conjunction" }).format(items);
  const withSecret = () => origins().filter((origin) => props.state.secretOrigins?.[origin]?.length);
  const withoutSecret = () => origins().filter((origin) => !props.state.secretOrigins?.[origin]?.length);
  const pages = () => (props.state.automations ?? []).some((automation) => automation.kind === "route" && !automation.isNew);
  const owner = () => props.data.owner.runsAs;
  const foot = () =>
    [
      personal(props.data)
        ? owner()
          ? t().mayFootOther({ name: owner()!.name })
          : t().mayFootYou
        : t().mayFootAccount({ name: props.text.account() ?? props.state.code.title }),
      pages() ? "" : t().noPages,
    ]
      .filter(Boolean)
      .join(" ");
  const count = () =>
    (words()?.mayDo.items.length ?? 0) +
    (words()?.mayDo.more ?? 0) +
    withSecret().length +
    (withoutSecret().length ? 1 : 0) +
    (props.state.databaseUsed || props.state.code.database ? 1 : 0);
  const mb = (bytes: number) => `${new Intl.NumberFormat(props.text.locale(), { maximumFractionDigits: 1 }).format(bytes / 1048576)} MB`;
  return (
    <Island
      class="cloud-code__may"
      title={t().mayTitle}
      meta={words() ? String(count()) : undefined}
      state={words() ? "ready" : "error"}
      errorMessage={t().partFailed}
      onRetry={() => refreshCurrentPath()}
      loadingRows={3}
    >
      <Show when={count() > 0} fallback={<p class="cloud-code__quiet-line">{t().mayEmpty}</p>}>
        <ul class="cloud-code__rows" data-plain="">
          <For each={words()?.mayDo.items ?? []}>
            {(row) => {
              const parts = splitRow(row.text);
              // The place as quiet text, never a link (v12 picture 19): its kind and its name, "Postfach info@…".
              // A grant on the whole app names the app as its place ("Spaces · Spaces"): the app alone says it once.
              const place = () => {
                const text = placeText(row, parts.rest, props.state, props.data.owner.title);
                return row.app && text.localeCompare(row.app, props.text.locale(), { sensitivity: "base" }) === 0 ? "" : text;
              };
              // Personal Code's chat: Core names it for the owner and says how it answers; the owner may choose another.
              // Only personal Code reads a binding (`undefined` otherwise); `null` means Core could not answer.
              const chatRow = () => row.target?.ref.type === "core.ai.chat" && props.state.chatBinding !== undefined;
              return (
                <Row
                  icon={iconClass(row.icon, "ti ti-apps")}
                  tile="app"
                  title={parts.head}
                  sub={
                    <Show
                      when={row.note}
                      fallback={
                        <>
                          {row.app}
                          <Show when={row.app && place()}>{" · "}</Show>
                          {place()}
                        </>
                      }
                    >
                      {(note) => note()}
                    </Show>
                  }
                  extra={
                    <Show when={chatRow()}>
                      <CodeChatRowAction codeId={props.state.code.id} binding={props.state.chatBinding ?? null} text={props.text} />
                    </Show>
                  }
                />
              );
            }}
          </For>
          <For each={withSecret()}>
            {(origin) => (
              <Row
                icon="ti ti-world"
                tile="web"
                title={t().internetCall({ hosts: hostOf(origin) })}
                sub={t().internetSecret({ names: list((props.state.secretOrigins?.[origin] ?? []).map((name) => `„${name}“`)) })}
              />
            )}
          </For>
          <Show when={withoutSecret().length > 0}>
            <Row
              icon="ti ti-world"
              tile="web"
              title={t().internetCall({ hosts: list(withoutSecret().map(hostOf)) })}
              sub={withSecret().length ? t().internetNoSecret : t().internetOnly({ count: withoutSecret().length })}
            />
          </Show>
          <Show when={props.state.databaseUsed || props.state.code.database}>
            <Row
              icon="ti ti-database"
              tile="data"
              title={t().databaseTitle}
              sub={
                props.state.code.database?.bytes != null ? `${t().databaseSub} · ${mb(props.state.code.database.bytes)}` : t().databaseSub
              }
              extra={
                <Show when={props.state.code.database}>
                  {(database) => (
                    <span class="cloud-code__row-extra">
                      <CodeDatabaseStatus codeId={props.state.code.id} database={database()} />
                    </span>
                  )}
                </Show>
              }
            />
          </Show>
        </ul>
        <Show when={words()?.mayDo.moreText}>{(more) => <p class="cloud-code__quiet-line">{more()}</p>}</Show>
      </Show>
      <p class="cloud-code__foot">{foot()}</p>
    </Island>
  );
}

/** Pages and addresses only when the automation has some (Mockup PAGES). */
function Pages(props: { state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const routes = () =>
    [...(props.state.automations ?? [])]
      .filter((automation) => automation.kind === "route" && automation.route)
      .sort((a, b) => Number(b.pageLink?.isRoot ?? false) - Number(a.pageLink?.isRoot ?? false));
  return (
    <Show when={routes().length > 0}>
      <Island class="cloud-code__pages" title={t().pagesTitle} meta={String(routes().length)}>
        <ul class="cloud-code__rows">
          <For each={routes()}>
            {(automation) => (
              <Row
                icon={automation.route!.public ? "ti ti-bolt" : "ti ti-browser"}
                tile="page"
                title={routeTitle(automation, props.text)}
                after={
                  <Show when={automation.route!.public}>
                    <Tag size="sm" icon="ti ti-world" class="cloud-code__public-tag">
                      {t().publicTag}
                    </Tag>
                  </Show>
                }
                sub={
                  automation.route!.public
                    ? t().pagePublic
                    : !["GET", "ALL"].includes(automation.route!.method)
                      ? t().pageInput
                      : automation.route!.page === false
                        ? t().pageData
                        : t().pageMembers
                }
                trail={
                  <>
                    <Show when={opensPage(automation) && props.state.code.state === "active"}>
                      <ButtonLink size="sm" variant="ghost" href={automation.pageLink!.href}>
                        <i class="ti ti-browser" aria-hidden="true" />
                        {t().launchOpen}
                      </ButtonLink>
                    </Show>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(new URL(routeHref(props.state.code.id, automation), location.origin).href);
                          toast.success(t().addressCopied);
                        } catch {
                          toast.error(t().addressCopyFailed, { title: t().addressCopyFailedTitle });
                        }
                      }}
                    >
                      <i class="ti ti-copy" aria-hidden="true" />
                      {t().addressCopy}
                    </Button>
                  </>
                }
              />
            )}
          </For>
        </ul>
        <Show when={props.state.code.state === "paused"}>
          <p class="cloud-code__foot">{t().pagesPaused}</p>
        </Show>
      </Island>
    </Show>
  );
}

/** The overview: approval and attention first, then the situation, then the topics as islands (Bild 19 to 21). */
export function CodeOverview(props: {
  data: CodePageData;
  state: CodePageReady;
  text: PageText;
  live: CodeLive;
  run: CodeRunAction;
  onActivate: () => void;
  footer?: JSX.Element;
}) {
  const t = props.text.t;
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
      <Show when={props.state.code.needsReconfirmation}>
        <NoticeCard tone="warning" title={t().reconfirmTitle} detail={t().reconfirmDescription} />
      </Show>
      <Show when={props.state.chatBinding}>
        {(binding) => <CodeChatMissing codeId={props.state.code.id} binding={binding()} state={props.state} text={props.text} />}
      </Show>
      <Show when={props.state.versionsFailed}>
        <NoticeCard
          tone="danger"
          icon="ti ti-cloud-off"
          title={t().versionsFailed}
          detail={t().loadKeeps}
          actions={
            <Button type="button" size="sm" variant="secondary" onClick={() => refreshCurrentPath()}>
              <i class="ti ti-refresh" aria-hidden="true" />
              {t().tryAgain}
            </Button>
          }
        />
      </Show>
      <Show when={props.state.proposal ?? props.state.waiting}>
        {(version) => (
          <CodeVersionApproval
            data={props.data}
            state={props.state}
            version={version()}
            words={props.state.words?.proposal ?? null}
            text={props.text}
            onActivate={props.onActivate}
          />
        )}
      </Show>
      <NeedsYou data={props.data} state={props.state} text={props.text} />
      <CodeLiveStrip
        data={props.data}
        state={props.state}
        live={props.live}
        text={props.text}
        next={nextRunOf(props.state)}
        nextState={nextRunStateOf(props.state)}
      />
      <div class="cloud-code__grid">
        <div class="cloud-code__stack">
          <Show when={!personal(props.data)}>
            <div class="cloud-code__o0">
              <Did state={props.state} live={props.live} text={props.text} />
            </div>
          </Show>
          <div class="cloud-code__o1">
            <When data={props.data} state={props.state} text={props.text} live={props.live} run={props.run} />
          </div>
          <div class="cloud-code__o5">
            <Pages state={props.state} text={props.text} />
          </div>
        </div>
        <div class="cloud-code__stack">
          <div class="cloud-code__o2">
            <MayDo data={props.data} state={props.state} text={props.text} />
          </div>
        </div>
      </div>
      {props.footer}
    </div>
  );
}
