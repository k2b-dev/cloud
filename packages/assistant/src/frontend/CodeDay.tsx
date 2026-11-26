import { Button, Paper, Skeleton, useLocale } from "@k2b/ui";
import { For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { DayLine, DayMark } from "./code-overview";
import { clock, codeHref, viewText } from "./code-overview-view";

// "Today" of My apps & automations: every listed Code's runs of the person's day on one line, with the counts as a
// sentence. v1 draws it on its own surface; v2 places it bare in its pane.
const HOURS = [0, 6, 12, 18, 24];

/** "Today": every listed Code's runs of the person's day on one line, with the counts as a sentence. */
export default function CodeDay(props: {
  /** Without its own surface, for a v2 pane that draws the frame. */
  bare?: boolean;
  line: DayLine | null | undefined;
  /** The person's day as Core read it; "now" and the time of each mark stand on it. */
  bounds: { from: string; to: string } | null;
  titles: ReadonlyMap<string, string>;
  timeZone: string;
  onRetry: () => void;
}) {
  const locale = useLocale();
  const t = () => viewText(locale());
  const sentence = (line: DayLine) => t().appsTodaySentence(line);
  const percent = (at: number) => `${(at * 100).toFixed(3)}%`;
  const span = (bounds: { from: string; to: string }) => Date.parse(bounds.to) - Date.parse(bounds.from);
  const markTime = (mark: DayMark) =>
    props.bounds
      ? clock(new Date(Date.parse(props.bounds.from) + mark.at * span(props.bounds)).toISOString(), locale(), props.timeZone)
      : "";
  /** Where "now" stands on the day, from 0 to 1; only a read day has it. */
  const now = () => (props.bounds ? Math.min(1, Math.max(0, (Date.now() - Date.parse(props.bounds.from)) / span(props.bounds))) : null);
  const markState = (mark: DayMark) =>
    mark.state === "succeeded"
      ? t().appsRunSucceeded
      : mark.state === "failed"
        ? t().appsRunFailed
        : mark.state === "skipped"
          ? t().appsRunSkipped
          : mark.state === "running"
            ? t().appsRunRunning
            : t().appsRunPlanned;
  const markHref = (mark: DayMark) =>
    mark.codeId
      ? mark.runId
        ? `${codeHref(mark.codeId)}?tab=runs&run=${encodeURIComponent(mark.runId)}`
        : codeHref(mark.codeId)
      : undefined;
  return (
    <Dynamic
      component={props.bare ? "section" : Paper}
      as="section"
      class="assistant-apps__today"
      data-bare={props.bare ? "" : undefined}
      aria-labelledby="assistant-apps-today"
    >
      <p class="assistant-apps__today-head">
        {/* Bare, the section around it already says "Today": the word stays only for assistive technology. */}
        <span id="assistant-apps-today" class={props.bare ? "sr-only" : "assistant-apps__today-title"}>
          {t().appsToday}
        </span>
        <Show when={props.line} fallback={<Show when={props.line === undefined}>{<Skeleton class="h-3 w-64" />}</Show>}>
          {(line) => <span class="assistant-apps__today-sentence">{sentence(line())}</span>}
        </Show>
      </p>
      <Show
        when={props.line !== null}
        fallback={
          <p class="assistant-apps__today-failed" role="alert">
            <i class="ti ti-cloud-off" aria-hidden="true" />
            <span>{t().appsDayFailed}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => props.onRetry()}>
              {t().codeViewRetry}
            </Button>
          </p>
        }
      >
        <Show when={props.line?.missing}>
          {(missing) => (
            <p class="assistant-apps__today-failed" role="status">
              <i class="ti ti-cloud-off" aria-hidden="true" />
              <span>{t().appsDayPartial({ count: missing() })}</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => props.onRetry()}>
                {t().codeViewRetry}
              </Button>
            </p>
          )}
        </Show>
        <div class="assistant-apps__day" aria-busy={props.line === undefined ? "true" : undefined}>
          <div
            class="assistant-apps__axis"
            role="img"
            aria-label={props.line ? t().appsDayLabel({ sentence: sentence(props.line) }) : t().appsDayMarks}
          >
            <span class="assistant-apps__axis-line">
              <Show when={now()}>{(at) => <i style={{ width: percent(at()) }} />}</Show>
            </span>
            <For each={HOURS}>
              {(hour) => (
                <span class="assistant-apps__hour" style={{ left: percent(hour / 24) }}>
                  {`${String(hour).padStart(2, "0")}:00`}
                </span>
              )}
            </For>
            <Show when={now()}>
              {(at) => (
                <span class="assistant-apps__now" style={{ left: percent(at()) }}>
                  <span>{t().appsDayNow}</span>
                </span>
              )}
            </Show>
          </div>
          <Show when={props.line}>
            {(line) => (
              <ul class="assistant-apps__marks" aria-label={t().appsDayMarks}>
                <For each={line().marks}>
                  {(mark) => {
                    const label = () =>
                      mark.state === "group" || (mark.state === "planned" && mark.count > 1)
                        ? t().appsGroupMark({ time: markTime(mark), count: mark.count })
                        : t().appsMark({
                            title: (mark.codeId && props.titles.get(mark.codeId)) || t().codeKind,
                            time: markTime(mark),
                            state: markState(mark),
                          });
                    return (
                      <li style={{ left: percent(mark.at) }}>
                        <Show
                          when={markHref(mark)}
                          fallback={
                            <span class="assistant-apps__mark" data-state={mark.state} role="img" aria-label={label()} title={label()} />
                          }
                        >
                          {(href) => (
                            <a class="assistant-apps__mark" data-state={mark.state} href={href()} title={label()}>
                              <span class="sr-only">{label()}</span>
                            </a>
                          )}
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ul>
            )}
          </Show>
        </div>
        <p class="assistant-apps__legend" aria-hidden="true">
          <span>
            <i class="assistant-apps__mark" data-state="succeeded" />
            {t().appsLegendSucceeded}
          </span>
          <span>
            <i class="assistant-apps__mark" data-state="failed" />
            {t().appsLegendFailed}
          </span>
          <span>
            <i class="assistant-apps__mark" data-state="planned" />
            {t().appsLegendPlanned}
          </span>
        </p>
      </Show>
    </Dynamic>
  );
}
