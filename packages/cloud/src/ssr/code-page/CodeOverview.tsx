import { documentNavigate, refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, ButtonLink, Dropdown, NoticeCard, Tag, toast } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import { openPanel } from "../../browser/panel";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import { CodeDatabaseStatus } from "./CodeDatabaseStatus";
import { type CodeLive, CodeLiveStrip, EffectRows } from "./CodeLiveStrip";
import { CodeVersionApproval } from "./CodeVersionApproval";
import { type CodePageAutomation, type CodePageData, type CodePageReady, StartSchema } from "./data";
import { Island, iconClass, ModelMark, type PageText, personal, Row, runStatus, Status, sentence, splitRow, withQuery } from "./page-kit";
import { describeCodeTiming } from "./schedule";

/** "When it runs" shows this many triggers before "Show n more". */
const WHEN_ROWS = 6;

/** The next start of any running automation, or null. */
export const nextRunOf = (state: CodePageReady): string | null =>
  (state.automations ?? [])
    .filter((automation) => !automation.isNew && automation.nextRunAt)
    .map((automation) => automation.nextRunAt!)
    .sort()[0] ?? null;

/** The newest run that ended; skipped and cancelled starts are not a result. */
export const lastFinishedRun = (state: CodePageReady) =>
  state.runs?.items.find((run) => run.state === "succeeded" || run.state === "failed") ?? null;

/** The sentence about what the automation does: Gustav's text with its mark, or the read model's restriction. */
export function CodeLede(props: { state: CodePageReady; text: PageText }) {
  const description = () => props.state.words?.current?.description ?? null;
  return (
    <Show when={description()?.text}>
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
          icon="ti ti-alert-circle"
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
                      <Button type="button" size="sm" variant="danger" onClick={() => openPanel(editor().provider)}>
                        <i class={editor().icon} aria-hidden="true" />
                        {t().changeWith({ name: editor().label })}
                      </Button>
                    )}
                  </Show>
                }
              >
                {(href) => (
                  <ButtonLink size="sm" variant="danger" href={href()}>
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
        <Show when={counters().length > 0}>
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

/** A manual or scheduled automation that runs now with the running version. */
const runnable = (state: CodePageReady) =>
  (state.automations ?? []).filter((automation) => !automation.isNew && (automation.kind === "schedule" || automation.kind === "manual"));

/** "Run now": one button for one automation, else a menu with each one by its name. */
function RunNow(props: { data: CodePageData; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const [starting, setStarting] = createSignal(false);
  const name = (automation: CodePageAutomation) => automation.title ?? sentence(timing(automation, props.text), props.text.locale());
  const start = async (automation: CodePageAutomation) => {
    if (starting()) return;
    setStarting(true);
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "core",
        capabilityId: "code.run",
        kind: "action",
        target: { type: "core.code", id: props.state.code.id },
        input: { entrypoint: automation.entrypoint, input: null },
        idempotencyKey: crypto.randomUUID(),
      },
      StartSchema,
    );
    setStarting(false);
    if (!result.ok) return toast.error(result.error.message);
    toast.success(t().runStarted);
    documentNavigate(withQuery(props.data.href, { tab: "runs", run: result.data.data.runId }));
  };
  const items = () => runnable(props.state);
  return (
    <Show when={props.state.permission === "editor" && props.state.code.state === "active" && items().length > 0}>
      <Show
        when={items().length > 1}
        fallback={
          <Button type="button" size="sm" variant="ghost" loading={starting()} onClick={() => void start(items()[0]!)}>
            <i class="ti ti-player-play" aria-hidden="true" />
            {t().runNow}
          </Button>
        }
      >
        <Dropdown.Root
          items={items().map((automation) => ({
            label: name(automation),
            icon: "ti ti-player-play",
            action: () => void start(automation),
          }))}
          label={t().runNow}
          position="bottom-right"
          phone="sheet"
        >
          <Dropdown.Trigger type="button" size="sm" variant="ghost" label={t().runNow} aria-busy={starting() ? "true" : undefined}>
            <i class="ti ti-player-play" aria-hidden="true" />
            {t().runNow}
            <i class="ti ti-chevron-down" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </Show>
    </Show>
  );
}

/** When an automation runs, in words: the read model's sentence, else the schedule, never its stable name. */
export const timing = (automation: CodePageAutomation, text: PageText): string => {
  const t = text.t();
  if (automation.timingText) return automation.timingText;
  const scheduled = describeCodeTiming(automation, text.locale());
  if (scheduled) return scheduled;
  return automation.kind === "event" ? t.triggerEvent : t.manualStart;
};

function When(props: { data: CodePageData; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const [all, setAll] = createSignal(false);
  const rows = () => (props.state.automations ?? []).filter((automation) => automation.kind !== "route");
  const shown = () => (all() ? rows() : rows().slice(0, WHEN_ROWS));
  const paused = () => props.state.code.state === "paused";
  const trail = (automation: CodePageAutomation): JSX.Element => {
    if (automation.isNew) return null;
    if (paused()) return <Status tone="warn" icon="ti ti-player-pause" label={t().statePaused} />;
    const run = automation.lastRun;
    return (
      <>
        <Show when={run} fallback={<Status tone="muted" icon="ti ti-minus" label={t().whenNever} />}>
          {(last) => (
            <Status
              {...runStatus(last().state, t())}
              label={
                last().state === "failed"
                  ? t().whenFailed({ when: props.text.moment(last().createdAt) })
                  : props.text.moment(last().createdAt)
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
      actions={<RunNow data={props.data} state={props.state} text={props.text} />}
      state={props.state.automations ? "ready" : "error"}
      errorMessage={t().partFailed}
      onRetry={() => refreshCurrentPath()}
      loadingRows={2}
    >
      <Show when={rows().length > 0} fallback={<p class="cloud-code__quiet-line">{t().whenEmpty}</p>}>
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
        <ul class="cloud-code__rows">
          <For each={words()?.mayDo.items ?? []}>
            {(row) => {
              const parts = splitRow(row.text);
              return (
                <Row
                  icon={iconClass(row.icon, "ti ti-apps")}
                  tile="app"
                  title={parts.head}
                  sub={
                    <>
                      {row.app}
                      <Show when={row.app && parts.rest}>{" · "}</Show>
                      <Show when={parts.rest}>
                        {(rest) => (
                          <Show when={row.href} fallback={rest()}>
                            {(href) => <a href={href()}>{rest()}</a>}
                          </Show>
                        )}
                      </Show>
                    </>
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
  const routes = () => (props.state.automations ?? []).filter((automation) => automation.kind === "route" && automation.route);
  return (
    <Show when={routes().length > 0}>
      <Island class="cloud-code__pages" title={t().pagesTitle} meta={String(routes().length)}>
        <ul class="cloud-code__rows">
          <For each={routes()}>
            {(automation) => (
              <Row
                icon={automation.route!.public ? "ti ti-bolt" : "ti ti-browser"}
                tile="page"
                title={automation.title ?? automation.route!.path}
                after={
                  <Show when={automation.route!.public}>
                    <Tag size="sm" icon="ti ti-world" class="cloud-code__public-tag">
                      {t().publicTag}
                    </Tag>
                  </Show>
                }
                sub={automation.route!.public ? t().pagePublic : t().pageMembers}
              />
            )}
          </For>
        </ul>
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
      <CodeLiveStrip data={props.data} state={props.state} live={props.live} text={props.text} next={nextRunOf(props.state)} />
      <div class="cloud-code__grid">
        <div class="cloud-code__stack">
          <Show when={!personal(props.data)}>
            <div class="cloud-code__o0">
              <Did state={props.state} live={props.live} text={props.text} />
            </div>
          </Show>
          <div class="cloud-code__o1">
            <When data={props.data} state={props.state} text={props.text} />
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
