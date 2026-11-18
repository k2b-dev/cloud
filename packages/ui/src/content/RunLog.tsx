import { text } from "@k2b/stdlib";
import { createEffect, createMemo, createSignal, createUniqueId, type JSX, Show } from "solid-js";
import { Button, ButtonLink } from "../actions/Button";
import { Dropdown, type DropdownItem } from "../actions/Dropdown";
import { HoverCard } from "../feedback/HoverCard";
import { KeyedFor } from "../internal/keyed-for";
import { StepRowContent } from "../internal/step-row";
import { useLocale } from "../intl/locale";
import { useRunLogMessages } from "./run-log-messages";

export type RunLogState = "idle" | "starting" | "running" | "succeeded" | "failed";
export type RunLevel = "info" | "warn" | "error";
export type RunStepEntry = {
  kind: "step";
  id: string;
  at: string;
  label: string;
  /** Complete Tabler class, e.g. `ti ti-file-text`. */
  icon?: string;
  description?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  startedAt?: string;
  endedAt?: string;
  message?: string;
};
export type RunLogEntry = { kind: "log"; id: string; at: string; level: RunLevel; text: string };
export type RunEntry = RunStepEntry | RunLogEntry;
export type RunLogAction = {
  icon: string;
  label: string;
  onClick?: () => void;
  href?: string;
  primary?: boolean;
  disabled?: boolean;
  disabledReason?: string;
};
export type RunLogProps = {
  state: RunLogState;
  /** Unknown kinds are ignored. Later step records with the same id replace the row in its original position. */
  entries: readonly (RunEntry | { kind: string })[];
  /** Milliseconds supplied by the host. No clock runs inside RunLog. */
  duration?: number;
  meta?: JSX.Element;
  size?: "full" | "compact";
  /** Initial disclosure state; a changed value also updates the disclosure. */
  output?: "open" | "closed" | "hidden";
  olderCount?: number;
  onLoadOlder?: () => void;
  actions?: readonly RunLogAction[];
  label?: string;
  class?: string;
};

const isStep = (entry: RunLogProps["entries"][number]): entry is RunStepEntry => entry.kind === "step" && "label" in entry;
const isLog = (entry: RunLogProps["entries"][number]): entry is RunLogEntry => entry.kind === "log" && "text" in entry;
const clock = (ms: number) => {
  const seconds = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
const stepDuration = (step: RunStepEntry, locale: string) => {
  if (!step.startedAt || !step.endedAt) return undefined;
  const duration = Date.parse(step.endedAt) - Date.parse(step.startedAt);
  return Number.isFinite(duration) && duration >= 0 ? text.pprintDurationMs(duration, { locale }) : undefined;
};
const atTime = (at: string, formatter: Intl.DateTimeFormat) => {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? formatter.format(date) : at;
};
const headIcons: Record<RunLogState, string> = {
  idle: "ti ti-circle-dashed",
  starting: "ti ti-loader-2 k2b-spin",
  running: "ti ti-player-play",
  succeeded: "ti ti-circle-check",
  failed: "ti ti-alert-circle",
};
const markIcons = { pending: "", running: "", succeeded: "ti ti-check", failed: "ti ti-x", skipped: "ti ti-minus" };
// The approved many-step example keeps five rows and a navigation row in a fixed window.
const VISIBLE_STEPS = 5;

function StepMark(props: { status: RunStepEntry["status"]; icon?: string }) {
  return (
    <span class="k2b-run-log__mark" data-status={props.status} aria-hidden="true">
      <Show when={markIcons[props.status] || props.icon} fallback={<span class="k2b-run-log__pip" />}>
        <i class={markIcons[props.status] || props.icon} />
      </Show>
    </span>
  );
}

function RunStep(props: { step: RunStepEntry; state: RunLogState }) {
  const t = useRunLogMessages();
  const locale = useLocale();
  const status = () => (props.state === "succeeded" && props.step.status === "pending" ? "skipped" : props.step.status);
  const statusLabel = () =>
    ({ pending: t().pending, running: t().active, succeeded: t().completed, failed: t().stepFailed, skipped: t().skipped })[status()];
  return (
    <li class="k2b-run-log__step" data-status={status()}>
      <StepRowContent
        classes={{
          leading: "k2b-run-log__leading",
          label: "k2b-run-log__label",
          meta: "k2b-run-log__reason",
          duration: "k2b-run-log__duration",
        }}
        leading={<StepMark status={status()} icon={props.step.icon} />}
        label={
          <>
            <span class="k2b-run-log__name" title={props.step.label}>
              {props.step.label}
            </span>
            <Show when={props.step.description}>
              {(description) => (
                <HoverCard.Trigger
                  type="button"
                  triggerClass="k2b-run-log__info"
                  content={description()}
                  aria-label={t().details({ label: props.step.label })}
                >
                  <i class="ti ti-info-circle" aria-hidden="true" />
                </HoverCard.Trigger>
              )}
            </Show>
          </>
        }
        meta={
          <Show when={props.step.message}>
            {(message) => (
              <HoverCard.Trigger type="button" triggerClass="k2b-run-log__reason-button" content={message()}>
                <span>{message()}</span>
              </HoverCard.Trigger>
            )}
          </Show>
        }
        duration={status() === "skipped" ? t().skipped : stepDuration(props.step, locale())}
        statusLabel={statusLabel()}
      />
    </li>
  );
}

function RunActions(props: { actions: readonly RunLogAction[] }) {
  const t = useRunLogMessages();
  const items = (): DropdownItem[] =>
    props.actions.map((action) => {
      const base = {
        label: action.label,
        icon: action.icon,
        description: action.disabledReason,
        variant: action.primary ? ("accent" as const) : undefined,
      };
      if (action.disabled || (!action.href && !action.onClick)) return { ...base, disabled: true };
      if (action.href) return { ...base, href: action.href, action: action.onClick };
      return { ...base, action: action.onClick! };
    });
  return (
    <div class="k2b-run-log__actions" data-multiple={props.actions.length > 1 ? "true" : undefined}>
      <div class="k2b-run-log__inline-actions">
        <KeyedFor each={props.actions} by={(action) => action.label}>
          {(action) => (
            <Show
              when={action().href && !action().disabled}
              fallback={
                <Button
                  size="xs"
                  variant="ghost"
                  class="k2b-run-log__action"
                  data-primary={action().primary ? "true" : undefined}
                  disabled={action().disabled || (!action().onClick && !action().href)}
                  tooltip={action().disabledReason}
                  onClick={() => action().onClick?.()}
                >
                  <i class={action().icon} aria-hidden="true" />
                  <span>{action().label}</span>
                </Button>
              }
            >
              <ButtonLink
                size="xs"
                variant="ghost"
                class="k2b-run-log__action"
                data-primary={action().primary ? "true" : undefined}
                href={action().href}
                onClick={() => action().onClick?.()}
              >
                <i class={action().icon} aria-hidden="true" />
                <span>{action().label}</span>
              </ButtonLink>
            </Show>
          )}
        </KeyedFor>
      </div>
      <Show when={props.actions.length > 1}>
        <div class="k2b-run-log__more-actions">
          <Dropdown.Root items={items()} position="bottom-right">
            <Dropdown.Trigger iconOnly size="xs" variant="ghost" class="k2b-run-log__action" label={t().actions} title={t().actions}>
              <i class="ti ti-dots" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
      </Show>
    </div>
  );
}

/** A run's steps and output. Presentation and disclosures only; the host owns execution, time, connection, and history. */
export function RunLog(props: RunLogProps): JSX.Element {
  const t = useRunLogMessages();
  const locale = useLocale();
  const time = createMemo(() => new Intl.DateTimeFormat(locale(), { timeStyle: "medium" }));
  const bodyId = createUniqueId();
  const outputId = createUniqueId();
  const [expanded, setExpanded] = createSignal(false);
  const [outputOpen, setOutputOpen] = createSignal(props.output === "open");
  createEffect(() => setOutputOpen(props.output === "open"));
  const [windowStart, setWindowStart] = createSignal<number>();
  const steps = createMemo(() => {
    const rows = new Map<string, RunStepEntry>();
    for (const entry of props.entries) if (isStep(entry)) rows.set(entry.id, entry);
    return [...rows.values()];
  });
  const logs = createMemo(() => props.entries.filter(isLog));
  const outputLines = createMemo(() => {
    const lines: { id: string; at: string; level: RunLevel | "step"; text: string }[] = [];
    for (const step of steps()) {
      if (step.startedAt) lines.push({ id: `step:${step.id}`, at: step.startedAt, level: "step", text: step.label });
    }
    for (const line of logs()) lines.push({ ...line, id: `log:${line.id}` });
    return lines.sort((a, b) => {
      const delta = Date.parse(a.at) - Date.parse(b.at);
      return Number.isFinite(delta) ? delta : 0;
    });
  });
  // A known plan reserves its rows before execution; an empty open output reserves its band too.
  const hasBody = () => steps().length > 0 || outputOpen() || (props.state !== "idle" && props.state !== "starting");
  const compact = () => props.size === "compact";
  const visible = () => !compact() || expanded();
  const current = () => steps().find((step) => step.status === "running") ?? steps().find((step) => step.status === "failed");
  const lastStart = () => Math.max(0, steps().length - VISIBLE_STEPS);
  const currentStart = () => (current() ? Math.min(steps().indexOf(current()!), lastStart()) : lastStart());
  const start = () => Math.min(windowStart() ?? currentStart(), lastStart());
  const browseSteps = () => {
    if (start() > 0) setWindowStart(Math.max(0, start() - VISIBLE_STEPS));
    else setWindowStart(windowStart() === undefined ? lastStart() : undefined);
  };
  const stateLabel = () =>
    ({ idle: t().idle, starting: t().starting, running: t().running, succeeded: t().succeeded, failed: t().failed })[props.state];
  const main = () => {
    if (props.state === "running") return props.duration === undefined ? t().running : t().since({ duration: clock(props.duration) });
    if (props.state === "succeeded")
      return props.duration === undefined ? t().succeeded : t().doneAfter({ duration: clock(props.duration) });
    if (props.state === "failed") return props.duration === undefined ? t().failed : t().failedAfter({ duration: clock(props.duration) });
    return props.state === "idle" ? t().idle : t().starting;
  };
  const compactMain = () =>
    props.state === "running" || props.state === "failed"
      ? (current()?.label ?? main())
      : props.state === "succeeded"
        ? t().succeeded
        : main();
  const compactMeta = () => {
    if (props.state === "running" && current())
      return [
        t().progress({ current: steps().indexOf(current()!) + 1, count: steps().length }),
        props.duration === undefined ? "" : clock(props.duration),
      ]
        .filter(Boolean)
        .join(" · ");
    if (props.state === "succeeded")
      return [
        steps().length === 1 ? t().step : t().steps({ count: steps().length }),
        props.duration === undefined ? "" : clock(props.duration),
      ]
        .filter(Boolean)
        .join(" · ");
    if (props.state === "failed")
      return [t().stepFailed, props.duration === undefined ? "" : clock(props.duration)].filter(Boolean).join(" · ");
    return props.meta;
  };
  const count = () => outputLines().length + (props.olderCount ?? 0);
  const counts = () => {
    if (!count()) return t().noLines;
    const warnings = logs().filter((line) => line.level === "warn").length;
    const errors = logs().filter((line) => line.level === "error").length;
    return [
      count() === 1 ? t().line : t().lines({ count: count() }),
      warnings ? (warnings === 1 ? t().warning : t().warnings({ count: warnings })) : "",
      errors ? (errors === 1 ? t().error : t().errors({ count: errors })) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  let output: HTMLDivElement | undefined;
  let followOutput = true;
  createEffect(() => {
    outputLines();
    if (props.state === "idle" || props.state === "starting") followOutput = true;
    // Reading away from the end pauses following. New batches never scroll the page.
    if (output && followOutput) output.scrollTop = output.scrollHeight;
  });
  return (
    <section
      class={`k2b-run-log k2b-focus-inset ${props.class ?? ""}`}
      data-state={props.state}
      data-size={props.size ?? "full"}
      data-expanded={visible() ? "true" : "false"}
      data-body={hasBody() ? "true" : "false"}
      aria-label={props.label ?? t().run}
    >
      <header class="k2b-run-log__head">
        <span class="k2b-run-log__head-icon" aria-hidden="true">
          <Show when={compact()} fallback={<i class={headIcons[props.state]} />}>
            <StepMark status={props.state === "idle" ? "pending" : props.state === "starting" ? "running" : props.state} />
          </Show>
        </span>
        <span class="k2b-sr-only" role="status">
          {stateLabel()}
        </span>
        <span class="k2b-run-log__main" title={compact() && !expanded() ? compactMain() : main()}>
          {compact() && !expanded() ? compactMain() : main()}
        </span>
        <span class="k2b-run-log__meta">{compact() && !expanded() ? compactMeta() : props.meta}</span>
        <Show when={props.actions?.length}>
          <RunActions actions={props.actions!} />
        </Show>
        <Show when={compact()}>
          <i class="ti ti-chevron-down k2b-run-log__chevron" aria-hidden="true" />
          <button
            type="button"
            class="k2b-run-log__toggle"
            aria-label={t().toggle}
            aria-expanded={expanded()}
            aria-controls={bodyId}
            onClick={() => setExpanded(!expanded())}
          />
        </Show>
      </header>
      <div class="k2b-run-log__fold" id={bodyId} data-open={visible() ? "true" : "false"} inert={!visible()} aria-hidden={!visible()}>
        <div class="k2b-run-log__clip">
          <Show when={hasBody()}>
            <Show when={steps().length}>
              <ol class="k2b-run-log__steps">
                <Show when={steps().length > VISIBLE_STEPS}>
                  <li class="k2b-run-log__earlier">
                    <button type="button" onClick={browseSteps}>
                      <StepMark status="succeeded" />
                      <span>
                        {start()
                          ? t().earlier({ count: start() })
                          : windowStart() === undefined
                            ? t().later({ count: lastStart() })
                            : t().current}
                      </span>
                    </button>
                  </li>
                </Show>
                <KeyedFor each={steps().slice(start(), start() + VISIBLE_STEPS)} by={(step) => step.id}>
                  {(step) => <RunStep step={step()} state={props.state} />}
                </KeyedFor>
              </ol>
            </Show>
            <Show when={props.output !== "hidden"}>
              <button
                type="button"
                class="k2b-run-log__output-toggle"
                aria-expanded={outputOpen()}
                aria-controls={outputId}
                onClick={() => setOutputOpen(!outputOpen())}
              >
                <i class="ti ti-chevron-right" aria-hidden="true" />
                <span>{t().output}</span>
                <span class="k2b-run-log__counts">{counts()}</span>
              </button>
              <div
                class="k2b-run-log__fold"
                id={outputId}
                data-open={outputOpen() ? "true" : "false"}
                inert={!outputOpen()}
                aria-hidden={!outputOpen()}
              >
                <div class="k2b-run-log__clip">
                  <div
                    ref={output}
                    class="k2b-run-log__output"
                    role="log"
                    aria-live="off"
                    aria-label={t().output}
                    tabIndex={0}
                    onScroll={(event) => {
                      const node = event.currentTarget;
                      followOutput = Math.ceil(node.scrollTop + node.clientHeight) >= node.scrollHeight;
                    }}
                  >
                    <Show when={props.olderCount}>
                      <button
                        type="button"
                        class="k2b-run-log__older"
                        disabled={!props.onLoadOlder}
                        onClick={() => {
                          followOutput = false;
                          props.onLoadOlder?.();
                        }}
                      >
                        {t().older({ count: props.olderCount! })}
                      </button>
                    </Show>
                    <KeyedFor each={outputLines()} by={(line) => line.id}>
                      {(line) => (
                        <div class="k2b-run-log__line" data-level={line().level}>
                          <time dateTime={line().at}>{atTime(line().at, time())}</time>
                          <span>
                            <Show when={line().level === "step"}>
                              <span aria-hidden="true">▸ </span>
                            </Show>
                            <Show when={line().level === "warn" || line().level === "error"}>
                              <i
                                class={line().level === "warn" ? "ti ti-alert-triangle" : "ti ti-x"}
                                role="img"
                                aria-label={line().level === "warn" ? t().warningLevel : t().errorLevel}
                              />{" "}
                            </Show>
                            {line().text}
                          </span>
                        </div>
                      )}
                    </KeyedFor>
                  </div>
                </div>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </section>
  );
}
