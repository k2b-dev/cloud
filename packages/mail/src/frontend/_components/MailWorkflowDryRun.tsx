import { Button, ChoiceChips, DotStrip, IconButton, ProgressBar, Skeleton, Tooltip, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import type { WorkflowTryItem, WorkflowTryPreflight, WorkflowTryResult } from "../../contracts";
import { dryRunTone, formatDryRunDetail } from "./mail-workflow-dry-run-format";
import { mailWorkflowDryRunMessages } from "./mail-workflow-dry-run-messages";

type Phase = "idle" | "running" | "done" | "canceled" | "failed";
type Filter = "all" | WorkflowTryItem["outcome"];
type AiCalls = WorkflowTryResult["aiCalls"];

export type MailWorkflowDryRunProps = {
  /** Loads one batch; the panel calls it again with the returned cursor until it is null. */
  run: (cursor: string | null, signal: AbortSignal) => Promise<WorkflowTryResult>;
  /** Each new value starts a fresh run, for example from the Probelauf button or the P key. */
  startToken: number;
  /** Shown instead of a run while the rule cannot be checked, for example while the YAML is invalid. */
  blocked?: boolean;
  mailboxName: string;
  last?: number;
  /** Shows the "Checked in advance" lines for targets and sending. */
  showPreflight?: boolean;
  /** Shows a hint that the AI's choice only appears in the real run. */
  aiChoiceHint?: boolean;
  /** Forces the narrow layout (no filter chips, two rows of dots); otherwise the panel picks it below 480 px. */
  compact?: boolean;
  /** Clock for "x min ago"; tests pass a fixed one. */
  now?: () => number;
};

const SKELETON_ROWS = 2;
/** Below this width the panel shows two rows of 25 dots and leaves out the filters, as on a phone. */
const COMPACT_WIDTH = 480;

export default function MailWorkflowDryRun(props: MailWorkflowDryRunProps) {
  const locale = useLocale();
  const t = createMemo(() => mailWorkflowDryRunMessages.resolve([locale()]).t);
  const now = () => props.now?.() ?? Date.now();
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [items, setItems] = createSignal<WorkflowTryItem[]>([]);
  const [total, setTotal] = createSignal(props.last ?? 50);
  const [aiCalls, setAiCalls] = createSignal<AiCalls>({ min: 0, max: 0 });
  const [dailyLimit, setDailyLimit] = createSignal<number | null>(null);
  const [preflight, setPreflight] = createSignal<WorkflowTryPreflight | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [finishedAt, setFinishedAt] = createSignal<number | null>(null);
  const [clock, setClock] = createSignal(now());
  const [filter, setFilter] = createSignal<Filter>("all");
  const [active, setActive] = createSignal<number | null>(null);
  const [narrow, setNarrow] = createSignal(false);
  const compact = () => props.compact ?? narrow();
  let controller: AbortController | null = null;
  let panel: HTMLElement | undefined;
  onMount(() => {
    if (!panel || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? COMPACT_WIDTH) < COMPACT_WIDTH));
    observer.observe(panel);
    onCleanup(() => observer.disconnect());
  });

  const timer = setInterval(() => setClock(now()), 30_000);
  onCleanup(() => {
    clearInterval(timer);
    controller?.abort();
  });

  const start = async () => {
    controller?.abort();
    const current = new AbortController();
    controller = current;
    setItems([]);
    setAiCalls({ min: 0, max: 0 });
    setError(null);
    setFinishedAt(null);
    setFilter("all");
    setActive(null);
    setPhase("running");
    let cursor: string | null = null;
    try {
      do {
        const batch: WorkflowTryResult = await props.run(cursor, current.signal);
        if (current.signal.aborted) return;
        setTotal(batch.window.total);
        setItems((previous) => [...previous, ...batch.items]);
        setAiCalls((previous) => ({ min: previous.min + batch.aiCalls.min, max: previous.max + batch.aiCalls.max }));
        setDailyLimit(batch.maxAiCallsPerDay);
        setPreflight(batch.preflight);
        cursor = batch.cursor;
      } while (cursor !== null);
      setPhase("done");
    } catch (failure) {
      if (current.signal.aborted) return;
      setError(failure instanceof Error ? failure.message : String(failure));
      setPhase("failed");
    } finally {
      if (controller === current) {
        controller = null;
        setFinishedAt(now());
        setClock(now());
      }
    }
  };

  const cancel = () => {
    if (!controller) return;
    controller.abort();
    controller = null;
    setPhase("canceled");
    setFinishedAt(now());
  };

  createEffect(
    on(
      () => props.startToken,
      (token) => {
        if (token > 0 && !props.blocked) void start();
      },
    ),
  );
  createEffect(
    on(
      () => props.blocked,
      (blocked) => {
        if (blocked && controller) cancel();
      },
    ),
  );

  const counts = createMemo(() => {
    const result = { match: 0, skipped: 0, none: 0 };
    for (const item of items()) result[item.outcome] += 1;
    return result;
  });
  const visible = createMemo(() => (filter() === "all" ? items() : items().filter((item) => item.outcome === filter())));
  const tones = createMemo(() => items().map(dryRunTone));
  const ago = () => {
    const at = finishedAt();
    if (at === null) return "";
    const minutes = Math.floor((clock() - at) / 60_000);
    return minutes < 1 ? t().justNow : t().minutesAgo({ minutes });
  };
  const aiLine = () => {
    const calls = aiCalls();
    if (calls.max === 0) return phase() === "done" ? t().noAi : null;
    const limit = dailyLimit();
    const base = t().aiCalls(calls);
    if (!limit) return base;
    const percent = Math.round((calls.max / limit) * 100);
    return `${base} · ${t().ofDailyLimit({ percent, range: calls.min !== calls.max })}`;
  };
  const selected = () => active() ?? (phase() === "done" && items().length > 0 ? 0 : null);
  const hasRun = () => phase() !== "idle";
  const done = () => items().length;

  return (
    <section
      ref={panel}
      class="flex min-w-0 flex-col gap-2.5"
      aria-labelledby="mail-workflow-dry-run-title"
      data-mail-workflow-dry-run={phase()}
    >
      {/* The right side keeps one width in every phase, so the title wraps the same while running and when done. */}
      <header class="grid min-h-8 items-center gap-x-2.5 gap-y-1" classList={{ "grid-cols-[minmax(0,1fr)_auto]": !compact() }}>
        <h3 id="mail-workflow-dry-run-title" class="min-w-0 text-sm font-semibold text-primary">
          {hasRun() || !props.blocked ? t().title({ last: props.last ?? 50 }) : t().titleShort}
        </h3>
        <div class="flex items-center justify-end gap-2" classList={{ "w-[15rem]": !compact() }}>
          <span class="min-w-0 whitespace-nowrap text-xs text-dimmed tabular-nums" classList={{ "mr-auto": compact() }} aria-live="polite">
            <Show when={phase() === "running"}>{t().checked({ done: done(), total: total() })}</Show>
            <Show when={phase() === "canceled"}>{t().canceledAt({ done: done(), total: total() })}</Show>
            <Show when={phase() === "done" || phase() === "failed"}>{ago()}</Show>
          </span>
          <Show
            when={phase() === "running"}
            fallback={
              <Show when={hasRun()}>
                <Tooltip.Anchor content={t().restart}>
                  <IconButton size="sm" variant="ghost" label={t().restart} disabled={props.blocked} onClick={() => void start()}>
                    <i class="ti ti-refresh" aria-hidden="true" />
                  </IconButton>
                </Tooltip.Anchor>
              </Show>
            }
          >
            <Button size="sm" variant="secondary" onClick={cancel}>
              {t().cancel}
            </Button>
          </Show>
        </div>
      </header>

      {/* The bar keeps its row in every phase, so finishing a run moves nothing. */}
      <div class="h-1.5" classList={{ invisible: phase() !== "running" }}>
        <ProgressBar size="xs" value={total() > 0 ? (done() / total()) * 100 : 0} label={t().progressLabel} />
      </div>

      <Show
        when={hasRun()}
        fallback={
          <div class="flex flex-col gap-2.5">
            <DotStrip dots={[]} length={props.last ?? 50} waiting size="lg" columns={compact() ? 25 : undefined} label={t().titleShort} />
            <p class="text-sm text-dimmed">{props.blocked ? t().waiting : t().idle}</p>
            <Show when={!props.blocked}>
              <div>
                <Button size="sm" variant="secondary" onClick={() => void start()}>
                  <i class="ti ti-player-play" aria-hidden="true" />
                  {t().start}
                </Button>
              </div>
            </Show>
          </div>
        }
      >
        <div
          class="grid items-baseline gap-x-4 gap-y-1 text-xs text-dimmed"
          classList={{ "grid-cols-3": !compact(), "grid-cols-2": compact() }}
        >
          <For
            each={[
              { count: counts().match, label: t().match, accent: true },
              { count: counts().skipped, label: t().skipped, accent: false },
              { count: counts().none, label: t().none, accent: false },
            ]}
          >
            {(group) => (
              <p class="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap" data-dry-run-count>
                <span
                  class="min-w-[1.4em] text-right text-[1.75rem] leading-none font-semibold tabular-nums"
                  classList={{ "app-accent-text": group.accent, "text-primary": !group.accent }}
                >
                  {group.count}
                </span>
                <span>{group.label}</span>
              </p>
            )}
          </For>
        </div>
        <DotStrip
          dots={tones()}
          length={Math.max(total(), items().length)}
          selected={selected()}
          size="lg"
          columns={compact() ? 25 : undefined}
          label={t().stripLabel({ total: total(), ...counts() })}
        />
        <Show when={aiLine()}>
          {(line) => (
            <p class="flex items-center gap-1.5 text-xs text-dimmed">
              <Show when={aiCalls().max > 0}>
                <i class="ti ti-sparkles text-[color:var(--k2b-ai-accent)]" aria-hidden="true" />
              </Show>
              <span>{line()}</span>
            </p>
          )}
        </Show>
        <Show when={props.aiChoiceHint && aiCalls().max > 0}>
          <p class="text-xs text-dimmed">{t().aiChoiceHint}</p>
        </Show>
        <Show when={phase() === "failed"}>
          <div class="flex flex-wrap items-center gap-2" role="alert">
            <p class="text-sm text-primary">{t().failed({ reason: error() ?? "" })}</p>
            <Button size="sm" variant="secondary" onClick={() => void start()}>
              {t().retry}
            </Button>
          </div>
        </Show>
        <Show when={!compact() && items().length > 0}>
          <ChoiceChips
            aria-label={t().filterLabel}
            value={filter()}
            onValueChange={setFilter}
            options={[
              { value: "all", label: t().filterAll },
              { value: "match", label: t().filterMatch },
              { value: "skipped", label: t().filterSkipped },
              { value: "none", label: t().filterNone },
            ]}
          />
        </Show>
        <Show when={phase() !== "running" && total() === 0}>
          <p class="text-sm text-dimmed">{t().emptyWindow}</p>
        </Show>
        <ul class="flex flex-col gap-0.5" aria-label={t().titleShort}>
          <For each={visible()}>
            {(item) => {
              const detail = () => formatDryRunDetail(item, t());
              const index = () => items().indexOf(item);
              return (
                <li
                  class="grid min-h-13 grid-cols-[1.375rem_1fr] gap-2 rounded-[var(--ui-radius-control)] px-2 py-1.5 text-[0.8125rem] hover:bg-[var(--ui-hover)]"
                  data-outcome={item.outcome}
                  onMouseEnter={() => setActive(index())}
                  onMouseLeave={() => setActive(null)}
                >
                  <span class="pt-0.5 text-base leading-none" aria-hidden="true">
                    <Show
                      when={item.outcome === "match"}
                      fallback={
                        <i
                          class={
                            item.outcome === "skipped"
                              ? "ti ti-player-skip-forward text-amber-600 dark:text-amber-400"
                              : "ti ti-circle-minus text-dimmed"
                          }
                        />
                      }
                    >
                      <i
                        class={item.stoppedAtAi ? "ti ti-sparkles text-[color:var(--k2b-ai-accent)]" : "ti ti-circle-check app-accent-text"}
                      />
                    </Show>
                  </span>
                  <div class="min-w-0">
                    <p class="truncate text-primary">
                      <span class="font-semibold">{item.from.name || item.from.email}</span> · {item.subject}
                    </p>
                    <p class="text-xs text-dimmed">
                      {detail().facts}
                      <Show when={detail().effect}>
                        {(effect) => (
                          <>
                            {detail().facts ? " → " : ""}
                            <span class="font-medium app-accent-text">{effect()}</span>
                          </>
                        )}
                      </Show>
                    </p>
                    <For each={item.problems}>
                      {(problem) => (
                        <p class="text-xs text-red-700 dark:text-red-300">
                          {problem.code === "target_no_access"
                            ? t().problemNoAccess({ target: problem.target ?? "" })
                            : problem.code === "target_missing"
                              ? t().problemMissing({ target: problem.target ?? "" })
                              : t().problemNotAllowed}
                        </p>
                      )}
                    </For>
                  </div>
                </li>
              );
            }}
          </For>
          <Show when={phase() === "running"}>
            <For each={Array.from({ length: SKELETON_ROWS }, (_, index) => index)}>
              {(index) => (
                <li class="flex min-h-13 items-center px-2" aria-hidden="true">
                  <Skeleton class={`h-3 rounded ${index === 0 ? "w-4/5" : "w-2/3"}`} />
                </li>
              )}
            </For>
          </Show>
          <Show when={phase() !== "running" && items().length > 0 && visible().length === 0}>
            <li class="px-2 py-1.5 text-sm text-dimmed">{t().emptyFilter}</li>
          </Show>
        </ul>
        <Show when={props.showPreflight && phase() !== "running" && preflight()}>
          {(checks) => <MailWorkflowDryRunPreflight preflight={checks()} mailboxName={props.mailboxName} />}
        </Show>
      </Show>

      <p class="mt-1 flex items-center gap-1.5 text-xs text-dimmed">
        <i class="ti ti-shield-check" aria-hidden="true" />
        {t().footer}
      </p>
    </section>
  );
}

function MailWorkflowDryRunPreflight(props: { preflight: WorkflowTryPreflight; mailboxName: string }) {
  const locale = useLocale();
  const t = createMemo(() => mailWorkflowDryRunMessages.resolve([locale()]).t);
  const failing = () => props.preflight.targets.filter((target) => !target.ok);
  const okCount = () => props.preflight.targets.length;
  const line = (ok: boolean, text: string) => (
    <li class="grid grid-cols-[1.375rem_1fr] gap-2 text-[0.84375rem] leading-snug text-primary">
      <i
        class={
          ok
            ? "ti ti-circle-check mt-0.5 text-green-700 dark:text-green-400"
            : "ti ti-alert-triangle mt-0.5 text-amber-600 dark:text-amber-400"
        }
        aria-hidden="true"
      />
      <span>{text}</span>
    </li>
  );
  return (
    <div class="flex flex-col gap-1.5">
      <p class="text-xs font-semibold text-secondary">{t().checkedInAdvance}</p>
      <ul class="flex flex-col gap-1">
        <Show
          when={failing().length > 0}
          fallback={<Show when={okCount() > 0}>{line(true, t().targetsOk({ count: okCount(), mailbox: props.mailboxName }))}</Show>}
        >
          <For each={failing()}>
            {(target) =>
              line(
                false,
                target.problem === "target_missing"
                  ? t().targetMissing({ target: target.value })
                  : t().targetNoAccess({ target: target.value, mailbox: props.mailboxName }),
              )
            }
          </For>
        </Show>
        {line(!props.preflight.sends, props.preflight.sends ? t().sends : props.preflight.writesDrafts ? t().writesDrafts : t().neverSends)}
      </ul>
    </div>
  );
}
