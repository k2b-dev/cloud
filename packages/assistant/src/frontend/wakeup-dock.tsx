import { useLocale } from "@k2b/ui";
import { createSignal, lazy, Show, Suspense } from "solid-js";
import { aiWakeupWhen } from "../wakeup-when";
import { aiWakeupWords } from "./wakeup-line";
import type { AssistantWakeupContext } from "./wakeups";

const WakeupList = lazy(() => import("./wakeups").then((module) => ({ default: module.WakeupList })));

/**
 * Gustav's alarms above the field (Gustav alarms v1, F1 A): the 32 px row of "Queued" (v6) with the next alarm and
 * "+n", or the chip "Alarms · n" where the row shows "Waiting for you" or "Queued". It loads with the chat's first
 * alarm, from the server's snapshot; a press opens the list over the row. Without alarms there is neither row nor chip.
 */
export default function AssistantWakeupDock(props: { context: AssistantWakeupContext; layout: "line" | "chip" }) {
  const locale = useLocale();
  const t = () => aiWakeupWords.resolve([locale()]).t;
  const [open, setOpen] = createSignal(false);
  const items = () => props.context.items();
  const id = `assistant-wakeups-${Math.random().toString(36).slice(2, 10)}`;
  let root: HTMLDivElement | undefined;
  let toggle: HTMLButtonElement | undefined;
  return (
    <div ref={root} class="assistant-wakeups" data-layout={props.layout}>
      <Show when={props.layout === "line" && items()[0]}>
        {(next) => (
          <>
            <span class="assistant-queue__head">
              <i class={next().cron ? "ti ti-repeat" : "ti ti-alarm"} aria-hidden="true" />
              {t().head}
            </span>
            <span class="assistant-queue__next">
              <span class="assistant-wakeups__when">{aiWakeupWhen(next(), { locale: locale(), timeZone: props.context.timeZone })}</span>
              <span class="assistant-queue__text" title={next().note}>
                {next().note}
              </span>
            </span>
            <Show when={next().status === "missed"}>
              <span class="assistant-wakeups__state">
                <i class="ti ti-alert-triangle" aria-hidden="true" />
                {t().missed}
              </span>
            </Show>
          </>
        )}
      </Show>
      <button
        ref={toggle}
        type="button"
        class={props.layout === "chip" ? "assistant-queue__chip" : "assistant-queue__all"}
        aria-expanded={open() ? "true" : "false"}
        aria-controls={id}
        aria-label={props.layout === "line" ? t().show({ count: items().length }) : undefined}
        title={props.layout === "line" ? t().show({ count: items().length }) : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <Show
          when={props.layout === "chip"}
          fallback={
            <Show when={items().length > 1}>
              <span class="assistant-queue__count">+{items().length - 1}</span>
            </Show>
          }
        >
          <i class="ti ti-alarm" aria-hidden="true" /> <span>{t().head}</span> <span aria-hidden="true">·</span>{" "}
          <span class="assistant-queue__count">{items().length}</span>
        </Show>
        <i class="ti ti-chevron-up assistant-queue__chevron" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <Suspense>
          <WakeupList
            id={id}
            ctx={props.context}
            root={() => root}
            onClose={(focus) => {
              setOpen(false);
              if (focus) toggle?.focus();
            }}
          />
        </Suspense>
      </Show>
    </div>
  );
}
