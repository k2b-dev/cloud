import { DotStrip, type DotStripTone } from "@k2b/ui";
import { createSignal, For, type JSX, Show } from "solid-js";
import type { CodeActivityReadModel } from "../../contracts/code-read-model";
import type { CodePageData, CodePageReady, CodePageRun } from "./data";
import { iconClass, type PageText, runStatus, Status, withQuery } from "./page-kit";

/** At most this many runs fit the strip; older ones drop off the left. */
export const CODE_STRIP_RUNS = 30;
/** "What it did for you" keeps this many rows, each of one fixed height. */
export const CODE_RECENT_ROWS = 6;

/** One run as the live channel reports it: when it started and how it stands now. */
export type CodeLiveRun = Pick<CodePageRun, "id" | "state" | "createdAt"> & { title?: string };
/** One confirmed effect, in words, as the activity read model lists it. */
export type CodeLiveEffect = CodeActivityReadModel["recent"][number];
/**
 * What the lead's live binding (`defineLive()`, never polling) pushes into an open Code page. `run` adds a run or
 * updates one by ID: a new running run appears at the right of the strip and pulses; when it ends it settles in its
 * colour and "Last" changes. `effect` puts a confirmed effect on top of "What it did for you"; the oldest row drops out.
 */
export type CodeLiveFeed = { run: (run: CodeLiveRun) => void; effect: (effect: CodeLiveEffect) => void };

/** The page's live state: runs newest first, as Core lists them, and the latest effects. */
export function createCodeLive(state: CodePageReady) {
  const loaded = state.runs?.items.length ?? 0;
  const [runs, setRuns] = createSignal<CodeLiveRun[]>((state.runs?.items ?? []).map((run) => ({ ...run })));
  const [effects, setEffects] = createSignal<CodeLiveEffect[]>(state.words?.activity?.recent ?? []);
  const [fresh, setFresh] = createSignal<{ run: string | null; effect: string | null }>({ run: null, effect: null });
  const feed: CodeLiveFeed = {
    run: (run) => {
      setRuns((current) => {
        const index = current.findIndex((item) => item.id === run.id);
        // Bounded: a page left open keeps what it loaded plus the strip's length, never the whole history.
        if (index < 0) return [run, ...current].slice(0, Math.max(loaded, CODE_STRIP_RUNS));
        // A run keeps the time it started; an update changes only its state and title.
        return current.map((item, at) => (at === index ? { ...item, ...run, createdAt: item.createdAt } : item));
      });
      if (run.state !== "running" && run.state !== "queued") setFresh((current) => ({ ...current, run: run.id }));
    },
    effect: (effect) => {
      setEffects((current) =>
        [effect, ...current.filter((item) => !(item.runId === effect.runId && item.text === effect.text))].slice(0, CODE_RECENT_ROWS),
      );
      setFresh((current) => ({ ...current, effect: `${effect.runId}:${effect.text}` }));
    },
  };
  return { runs, effects, fresh, feed };
}
export type CodeLive = ReturnType<typeof createCodeLive>;

const tone = (state: CodePageRun["state"]): DotStripTone =>
  state === "succeeded" ? "success" : state === "failed" || state === "cancelled" ? "danger" : state === "skipped" ? "skipped" : "running";

/** The legend of the strip: each form with its word, in the strip's own shapes. */
function Legend(props: { text: PageText }) {
  const t = props.text.t;
  const item = (state: DotStripTone, label: string) => (
    <span class="cloud-code__legend-item">
      <DotStrip dots={[state]} shape="bar" label={label} />
      {label}
    </span>
  );
  return (
    <span class="cloud-code__legend" role="group" aria-label={t().legendLabel}>
      {item("success", t().legendSucceeded)}
      {item("danger", t().legendFailed)}
      {item("skipped", t().legendSkipped)}
    </span>
  );
}

/** The last runs as upright bars, oldest left, each one a link to its run. */
export function RunStrip(props: { data: CodePageData; live: CodeLive; text: PageText; caption: JSX.Element; showAll?: boolean }) {
  const t = props.text.t;
  const shown = () => props.live.runs().slice(0, CODE_STRIP_RUNS).reverse();
  const failed = () => shown().filter((run) => run.state === "failed" || run.state === "cancelled").length;
  return (
    <div class="cloud-code__runs">
      <div class="cloud-code__runs-head">
        <span class="cloud-code__meta">{props.caption}</span>
        <Show when={props.showAll}>
          <a class="cloud-code__meta-link" href={withQuery(props.data.href, { tab: "runs" })}>
            {t().allRuns}
          </a>
        </Show>
      </div>
      <DotStrip
        class="cloud-code__strip"
        shape="bar"
        size="lg"
        length={CODE_STRIP_RUNS}
        dots={shown().map((run) => tone(run.state))}
        hrefs={shown().map((run) => withQuery(props.data.href, { tab: "runs", run: run.id }))}
        labels={shown().map((run) => t().slotLabel({ when: props.text.moment(run.createdAt), status: runStatus(run.state, t()).label }))}
        label={t().stripLabel({ count: shown().length, failed: failed() })}
      />
      <Legend text={props.text} />
    </div>
  );
}

/** "Last 30 runs · today 9, 1 failed": counts of the strip and of today, in the page's time zone. */
export const stripCaption = (live: CodeLive, text: PageText) => {
  const shown = live.runs().slice(0, CODE_STRIP_RUNS);
  const today = shown.filter((run) => text.today(run.createdAt));
  return text.t().stripCaption({
    count: shown.length,
    today: today.length,
    failed: today.filter((run) => run.state === "failed" || run.state === "cancelled").length,
  });
};

/**
 * The situation of the automation, first and largest: when it runs next, how the last run ended, and the last runs.
 * A fixed grid keeps the strip in place whatever the text beside it says (6b).
 */
export function CodeLiveStrip(props: {
  data: CodePageData;
  state: CodePageReady;
  live: CodeLive;
  text: PageText;
  /** The next scheduled start; null when none is planned. */
  next: string | null;
  /** `none` only when Core says nothing is planned; otherwise an unknown next run reads as unknown. */
  nextState?: "planned" | "none" | "unavailable";
}) {
  const t = props.text.t;
  const paused = () => props.state.code.state === "paused";
  const last = () =>
    props.live.runs().find((run) => run.state === "succeeded" || run.state === "failed" || run.state === "cancelled") ?? null;
  const lastWords = () => {
    const run = last();
    if (!run) return null;
    return run.title ?? props.state.words?.runs[run.id]?.title ?? null;
  };
  return (
    <section class="cloud-code__lage" aria-label={t().nextRunLabel}>
      <div class="cloud-code__lage-cell">
        <span class="cloud-code__meta">{t().nextRunLabel}</span>
        <span class="cloud-code__lage-value">
          {paused()
            ? t().nextPaused
            : props.next
              ? props.text.moment(props.next)
              : props.nextState === "unavailable"
                ? t().nextUnknown
                : t().nextNone}
        </span>
      </div>
      <div class="cloud-code__lage-cell">
        <span class="cloud-code__meta">{t().lastLabel}</span>
        <Show when={last()} keyed fallback={<span class="cloud-code__lage-last">{t().lastNone}</span>}>
          {(run) => (
            <span class="cloud-code__lage-last" data-fresh={props.live.fresh().run === run.id ? "" : undefined}>
              <Status {...runStatus(run.state, t())} label={props.text.moment(run.createdAt)} />
              <Show when={lastWords()}>{(title) => <span class="cloud-code__lage-what">{title()}</span>}</Show>
            </span>
          )}
        </Show>
      </div>
      <RunStrip
        data={props.data}
        live={props.live}
        text={props.text}
        showAll
        caption={
          paused()
            ? t().stripPausedCaption({ count: Math.min(props.live.runs().length, CODE_STRIP_RUNS) })
            : stripCaption(props.live, props.text)
        }
      />
    </section>
  );
}

/** The effects list keeps its rows in a fixed number of fixed slots, so a new effect never moves what is below. */
export function EffectRows(props: { live: CodeLive; text: PageText }) {
  return (
    <ul class="cloud-code__feed" aria-label={props.text.t().didRecent}>
      <For each={props.live.effects().slice(0, CODE_RECENT_ROWS)}>
        {(effect) => (
          <li data-fresh={props.live.fresh().effect === `${effect.runId}:${effect.text}` ? "" : undefined}>
            <span class="cloud-code__tile k2b-icon-tile" data-tile={effect.icon ? "app" : "neutral"} data-size="sm" aria-hidden="true">
              <i class={iconClass(effect.icon, "ti ti-circle-check")} />
            </span>
            {/* Core says what happened as one sentence; a target the reader may open makes it a link. */}
            <span class="cloud-code__feed-text">
              <Show when={effect.href} fallback={effect.text}>
                {(href) => <a href={href()}>{effect.text}</a>}
              </Show>
            </span>
            <span class="cloud-code__feed-time">{props.text.moment(effect.at)}</span>
          </li>
        )}
      </For>
    </ul>
  );
}
