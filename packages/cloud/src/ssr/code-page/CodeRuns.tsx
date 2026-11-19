import { documentNavigate, refreshCurrentPath } from "@k2b/ssr/nav";
import { Button, FilterToggle, Placeholder, prompts, toast } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import { invokeCapabilityWithDataSchema } from "../../capabilities/client";
import { type CodeRunReadModel, CodeRunReadModelSchema } from "../../contracts/code-read-model";
import type { CodeLive } from "./CodeLiveStrip";
import { nextRunOf, timing } from "./CodeOverview";
import { CodeRunLog } from "./CodeRunLog";
import {
  type CodePageData,
  type CodePageInvoke,
  type CodePageReady,
  type CodePageRun,
  type CodePageRunDetail,
  type CodeRunFilter,
  coreQuery,
  type EventDeliverySchema,
  RunListSchema,
  StartSchema,
} from "./data";
import { Island, type PageText, Quiet, Row, runStatus, runStatusWords, Status, sentence, withQuery } from "./page-kit";

/** The browser calls Core's public Code capabilities with the person's own session, like any page. */
const browserInvoke: CodePageInvoke = (invocation, schema) => invokeCapabilityWithDataSchema(invocation, schema);
/** Each "Load older runs" shows this many more. */
const MORE = 20;

const matches = (run: CodePageRun, filter: CodeRunFilter) =>
  filter === "failed" ? run.state === "failed" || run.state === "cancelled" : filter === "skipped" ? run.state === "skipped" : true;

/** A run's title in words: what it confirmed, why it was skipped, else when and how it started; never its code name. */
export const runTitle = (run: CodePageRun, words: CodeRunReadModel | undefined, state: CodePageReady, text: PageText) => {
  if (words) return run.state === "skipped" && words.reason ? words.reason : words.title;
  const automation = state.automations?.find((entry) => entry.entrypoint === run.entrypoint);
  return (
    run.title ??
    (automation ? sentence(timing(automation, text), text.locale()) : text.t().runFallbackTitle({ when: text.moment(run.createdAt) }))
  );
};

const triggerWord = (run: CodePageRun, text: PageText) => {
  const t = text.t();
  return { schedule: t.triggerSchedule, manual: t.triggerManual, event: t.triggerEvent, path: t.triggerPath }[run.trigger];
};

/** Event deliveries that wait for admission or failed: named by their event, with a retry for editors. */
function EventDelivery(props: { delivery: z.infer<typeof EventDeliverySchema>; state: CodePageReady; text: PageText }) {
  const t = props.text.t;
  const [pending, setPending] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let retryKey: string | undefined;
  const title = () =>
    props.state.automations?.find((automation) => automation.event?.type === props.delivery.eventType)?.event?.title ?? t().triggerEvent;
  const retry = async () => {
    if (pending()) return;
    setPending(true);
    setFailed(false);
    try {
      retryKey ??= crypto.randomUUID();
      const result = await browserInvoke(
        {
          appId: "core",
          capabilityId: "code.event.redeliver",
          kind: "action",
          target: { type: "core.code", id: props.state.code.id },
          input: { deliveryId: props.delivery.id },
          idempotencyKey: retryKey,
        },
        z.object({ deliveryId: z.string() }),
      );
      if (!result.ok) return setFailed(true);
      retryKey = undefined;
      refreshCurrentPath();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <Row
      icon="ti ti-bolt"
      tile="event"
      title={sentence(title(), props.text.locale())}
      sub={
        <>
          {props.text.moment(props.delivery.createdAt)}
          {/* Only an outcome the page can say in words; a stable code alone is never shown. */}
          <Show when={props.delivery.code && t().outcome({ code: props.delivery.code }) !== props.delivery.code}>
            {" · "}
            {t().outcome({ code: props.delivery.code! })}
          </Show>
        </>
      }
      extra={
        <Show when={failed()}>
          <span role="alert" class="cloud-code__row-error">
            {t().deliveryRetryFailed}
          </span>
        </Show>
      }
      trail={
        <>
          <Status
            tone={props.delivery.state === "failed" ? "danger" : "muted"}
            icon={props.delivery.state === "failed" ? "ti ti-alert-circle" : "ti ti-hourglass"}
            label={props.delivery.state === "failed" ? t().deliveryFailed : t().deliveryWaiting}
          />
          <Show when={props.delivery.state === "failed" && props.state.permission === "editor" && props.state.code.state === "active"}>
            <Button type="button" size="sm" variant="secondary" loading={pending()} onClick={() => void retry()}>
              {t().deliveryRetry}
            </Button>
          </Show>
        </>
      }
    />
  );
}

/** The detail of one run in words (Bild 22): title, when and how, status, what happened, and what to do next. */
function RunDetail(props: { data: CodePageData; state: CodePageReady; detail: CodePageRunDetail; text: PageText; live: CodeLive }) {
  const t = props.text.t;
  // The detail owns trigger and timing metadata; the list only updates its live state.
  const run = () => ({
    ...props.detail.run,
    state: props.live.runs().find((run) => run.id === props.detail.run.id)?.state ?? props.detail.run.state,
  });
  const words = () => props.state.words?.runs[run().id];
  const [rerunning, setRerunning] = createSignal(false);
  const calls = () => props.detail.calls;
  const afterAction = () => run().trigger !== "path" && (calls() ?? []).some((call) => call.kind === "action");
  const canRerun = () =>
    run().state === "failed" &&
    (run().trigger === "event" ? run().startedAt !== null : afterAction()) &&
    props.state.permission === "editor" &&
    props.state.code.state === "active";
  const rerun = async () => {
    // The input is too large to carry along; Core keeps it, and cld code can start the run again.
    if (props.detail.inputTooLarge) return toast.error(t().rerunNeedsInput);
    const did = words()?.untilThen.items ?? [];
    const confirmed = await prompts.confirm(
      <div class="cloud-code__dialog">
        <Show when={did.length > 0} fallback={<p>{t().rerunNoEffect}</p>}>
          <p>{t().rerunAlready}</p>
          <ul class="cloud-code__confirm-list">
            <For each={did}>{(row) => <li>{row.text}</li>}</For>
          </ul>
        </Show>
        <p class="cloud-code__meta">{t().rerunNote}</p>
      </div>,
      { title: t().rerunTitle, confirmText: t().rerun, icon: "ti ti-refresh" },
    );
    if (!confirmed) return;
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
    ).catch(() => null);
    setRerunning(false);
    if (!result?.ok) return toast.error(t().rerunFailed);
    toast.success(t().rerunStarted);
    documentNavigate(withQuery(props.data.href, { tab: "runs", run: result.data.data.runId }));
  };
  const automation = () => props.state.automations?.find((entry) => entry.entrypoint === run().entrypoint);
  const meta = () =>
    [
      sentence(props.text.moment(run().createdAt), props.text.locale()),
      automation()
        ? t().runTriggerNamed({
            trigger: triggerWord(run(), props.text),
            name: sentence(timing(automation()!, props.text), props.text.locale()),
          })
        : triggerWord(run(), props.text),
      run().versionNumber ? t().runVersion({ version: run().versionNumber! }) : null,
      run().rerunByName ? t().rerunBy({ name: run().rerunByName! }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  const refusalHref = () => (props.detail.refusal?.kind === "target_refused" ? (props.detail.refusal.call?.target?.href ?? null) : null);
  /** An AI budget refusal has its own sentence: what was spent and when it frees up again. */
  const budget = () => {
    const code = props.detail.refusal?.code;
    return code === "code_ai_budget_limit"
      ? t().aiBudgetRefused
      : code === "code_ai_daily_budget_limit"
        ? t().aiDailyBudgetRefused
        : code === "code_ai_owner_daily_budget_limit"
          ? t().aiOwnerDailyBudgetRefused
          : null;
  };
  return (
    <section class="cloud-code__detail" aria-labelledby="cloud-code-run-title">
      <a class="cloud-code__back" href={withQuery(props.data.href, { tab: "runs" })}>
        <i class="ti ti-chevron-left" aria-hidden="true" />
        {t().tabRuns}
      </a>
      <header class="cloud-code__detail-head">
        <div class="cloud-code__detail-text">
          <h2 id="cloud-code-run-title">{runTitle(run(), words(), props.state, props.text)}</h2>
          <p class="cloud-code__meta">{meta()}</p>
        </div>
      </header>
      <CodeRunLog
        codeId={props.state.code.id}
        detail={{ ...props.detail, run: run() }}
        now={props.data.dates.now}
        timeZone={props.data.dates.timeZone}
        manager={props.state.permission === "editor"}
        confirmed={words()?.untilThen}
        reason={budget() ?? words()?.reason}
        actions={[
          ...(refusalHref() ? [{ icon: "ti ti-lock", label: t().checkAccess, href: refusalHref()! }] : []),
          ...(canRerun() ? [{ icon: "ti ti-refresh", label: t().rerunDots, disabled: rerunning(), onClick: () => void rerun() }] : []),
        ]}
      />
      <Show when={run().rerunOf}>
        {(original) => (
          <Quiet icon="ti ti-repeat">
            <a href={withQuery(props.data.href, { tab: "runs", run: original() })}>{t().rerunOfRun}</a>
          </Quiet>
        )}
      </Show>
      <Show when={canRerun()}>
        <Quiet icon="ti ti-info-circle">{t().rerunNote}</Quiet>
      </Show>
    </section>
  );
}

/** One failed load as a quiet block: what did not load, that nothing changed, and "Try again". */
export function Failed(props: { title: string; detail: string }) {
  return (
    <Placeholder
      state="error"
      variant="panel"
      icon="ti ti-cloud-off"
      title={props.title}
      description={props.detail}
      onRetry={() => refreshCurrentPath()}
    />
  );
}

/** The runs tab (Bild 22): strip on top, the list with filters on the left, one run in words on the right. */
export function CodeRuns(props: { data: CodePageData; state: CodePageReady; text: PageText; live: CodeLive }) {
  const t = props.text.t;
  const filter = () => props.state.runFilter ?? "all";
  const [shown, setShown] = createSignal(MORE);
  const [extra, setExtra] = createSignal<CodePageRun[]>([]);
  const [extraWords, setExtraWords] = createSignal<Record<string, CodeRunReadModel>>({});
  const [cursor, setCursor] = createSignal(props.state.runs?.nextCursor ?? null);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const all = () => [
    ...props.live.runs().map((run) => ({ ...(props.state.runs?.items.find((item) => item.id === run.id) ?? run), ...run }) as CodePageRun),
    ...extra(),
  ];
  const listed = () => all().filter((run) => matches(run, filter()));
  const visible = () => listed().slice(0, shown());
  const wordsOf = (run: CodePageRun) => props.state.words?.runs[run.id] ?? extraWords()[run.id];
  const selected = () => props.state.run?.run.id ?? null;
  /** Counts are exact only when every run is loaded; otherwise the chips name the filter without a number. */
  const count = (which: CodeRunFilter) => (cursor() === null ? all().filter((run) => matches(run, which)).length : null);
  // Pills with words and counts, no signs (Bild 22).
  const chip = (which: CodeRunFilter, label: string) => (
    <FilterToggle
      active={filter() === which}
      href={withQuery(props.data.href, { tab: "runs", filter: which === "all" ? undefined : which })}
      label={count(which) === null ? label : `${label} ${count(which)}`}
    />
  );
  const loadWords = async (runs: CodePageRun[]) => {
    const read = await Promise.all(
      runs.map(async (run) => {
        const result = await browserInvoke(
          coreQuery("code.run.words", { codeId: props.state.code.id, runId: run.id }),
          CodeRunReadModelSchema,
        ).catch(() => null);
        return result?.ok ? ([run.id, result.data.data] as const) : null;
      }),
    );
    setExtraWords({ ...extraWords(), ...Object.fromEntries(read.filter((entry) => entry !== null)) });
  };
  const more = async () => {
    if (loading()) return;
    setFailed(false);
    const next = shown() + MORE;
    // Older runs beyond the loaded page come from Core in pages; their words follow in one batch per page.
    if (listed().length < next && cursor()) {
      setLoading(true);
      const result = await browserInvoke(
        coreQuery("code.run.list", { codeId: props.state.code.id, limit: MORE, cursor: cursor() }),
        RunListSchema,
      ).catch(() => null);
      if (!result?.ok) {
        setLoading(false);
        return setFailed(true);
      }
      const numbers = new Map(props.state.versions.map((version) => [version.id, version.number]));
      setExtra([...extra(), ...result.data.data.items.map((run) => ({ ...run, versionNumber: numbers.get(run.versionId) ?? null }))]);
      setCursor(result.data.data.nextCursor);
    }
    const added = listed()
      .slice(shown(), next)
      .filter((run) => !wordsOf(run));
    if (added.length) {
      setLoading(true);
      await loadWords(added);
    }
    setLoading(false);
    setShown(next);
  };
  const empty = (): JSX.Element => {
    const next = nextRunOf(props.state);
    return (
      <Placeholder
        variant="panel"
        icon="ti ti-clock-play"
        title={t().runsEmptyTitle}
        description={next ? t().runsEmptyNext({ when: props.text.moment(next) }) : t().runsEmptyManual}
      />
    );
  };
  return (
    <div class="cloud-code__body">
      <Show when={props.state.runs} fallback={<Failed title={t().runsLoadFailed} detail={t().loadKeeps} />}>
        <Show when={all().length > 0} fallback={empty()}>
          <div class="cloud-code__md" data-phone={props.state.runSelected ? "detail" : "list"}>
            <div class="cloud-code__list-col">
              <div class="cloud-code__filters" role="group" aria-label={t().filterLabel}>
                {chip("all", t().filterAll)}
                {chip("failed", t().filterFailed)}
                {chip("skipped", t().filterSkipped)}
              </div>
              <Show when={props.state.runs?.eventDeliveries?.length}>
                <Island title={t().eventDeliveries}>
                  <ul class="cloud-code__rows">
                    <For each={props.state.runs?.eventDeliveries}>
                      {(delivery) => <EventDelivery delivery={delivery} state={props.state} text={props.text} />}
                    </For>
                  </ul>
                </Island>
              </Show>
              <Island title={t().tabRuns} class="cloud-code__list-island">
                <Show when={visible().length > 0} fallback={<p class="cloud-code__quiet-line">{t().runsFilterEmpty}</p>}>
                  <ul class="cloud-code__rows cloud-code__rows--pick cloud-code__run-rows">
                    <For each={visible()}>
                      {(run) => (
                        <Row
                          href={withQuery(props.data.href, { tab: "runs", run: run.id, filter: filter() === "all" ? undefined : filter() })}
                          current={run.id === selected()}
                          title={runTitle(run, wordsOf(run), props.state, props.text)}
                          sub={t().runSub({ when: props.text.moment(run.createdAt), trigger: triggerWord(run, props.text) })}
                          trail={<Status {...runStatus(run.state, t())} reserve={runStatusWords(t())} />}
                        />
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={failed()}>
                  <p class="cloud-code__row-error" role="alert">
                    {t().olderFailed}
                  </p>
                </Show>
                <Show when={listed().length > shown() || cursor()}>
                  <button type="button" class="cloud-code__more" aria-busy={loading() ? "true" : undefined} onClick={() => void more()}>
                    <i class={loading() ? "ti ti-loader-2 cloud-code__spin" : "ti ti-chevron-down"} aria-hidden="true" />
                    {t().olderRuns}
                  </button>
                </Show>
              </Island>
            </div>
            <div class="cloud-code__detail-col">
              <Show
                when={props.state.run}
                fallback={
                  <Show
                    when={props.state.selectionFailed}
                    fallback={<Placeholder variant="panel" icon="ti ti-list-search" title={t().pickRun} />}
                  >
                    <Failed title={t().runFailedToLoad} detail={t().selectionKeeps} />
                  </Show>
                }
              >
                {(detail) => <RunDetail data={props.data} state={props.state} detail={detail()} text={props.text} live={props.live} />}
              </Show>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  );
}
