import { useLocale } from "@k2b/ui";
import { Button, Canvas, Chip, Empty, Failed, Inline, Pane, StatusRow, Table } from "@k2b/ui/v2";
import { Show } from "solid-js";
import { ASSISTANT_ACCENT } from "../../accent";
import { nextCodeRun } from "../../code-summary";
import CodeDay from "../CodeDay";
import { type CodeCardStatus, type CodeOverviewItem, cardStatus, needsPerson } from "../code-overview";
import {
  type CodeOverviewProps,
  cardDescription,
  cardLastText,
  codeHref,
  createCodeOverview,
  dayOrTime,
  STATE,
  viewText,
} from "../code-overview-view";

const CHIP = { danger: "bad", warning: "warn" } as const;
/** Whether a state needs the person, so it is a chip with its colour. */
const CHIP_OF = (status: CodeCardStatus) => STATE[status].tone === "danger" || STATE[status].tone === "warning";

/** Each Code's mark: Gustav's colour, the symbol of what starts it (B: never grey without a reason). */
const markOf = (item: CodeOverviewItem) => {
  const automations = item.automations ?? [];
  const kind = automations.length === 1 ? automations[0]!.kind : null;
  const icon =
    kind === "schedule" ? "clock" : kind === "event" ? "bolt" : kind === "manual" ? "hand-finger" : kind === "route" ? "world-www" : "code";
  return { icon, color: ASSISTANT_ACCENT };
};

/**
 * My apps & automations on v2 (screen brief 1 in the PR, recipe "overview", identity B): the hero says how many runs
 * today, its exceptions stand beside it as the chips that also filter (B rule 1), the day line is the hero's picture,
 * then one line per app (B rule 4). Explanations stand in the empty state only. The same state as v1
 * (`createCodeOverview`): the filter in the address, live runs, further pages.
 */
export default function AssistantAppsV2(props: CodeOverviewProps) {
  const locale = useLocale();
  const t = () => viewText(locale());
  // The exception chips always stand, so they always filter, also with fewer than FILTER_FROM apps.
  const o = createCodeOverview(props, 0);
  const runsToday = () => {
    const line = o.line();
    return line ? line.succeeded + line.failed + line.running + line.planned + line.grouped : null;
  };
  // As the recipe: a state that needs the person is a chip with its dot, every other one a plain word (B rule 7).
  const state = (status: CodeCardStatus) => {
    const shown = STATE[status];
    return shown.tone === "danger" || shown.tone === "warning" ? <Chip status={CHIP[shown.tone]}>{shown.word(t())}</Chip> : shown.word(t());
  };
  /** One meaning per column: when the Code runs next, else "–". */
  const next = (item: CodeOverviewItem) => {
    const at = cardStatus(item) === "on" ? nextCodeRun(item) : null;
    return at ? dayOrTime(at, t(), locale(), props.timeZone, o.now()) : "–";
  };
  const needingYou = () => o.items().filter((item) => needsPerson(cardStatus(item)));
  const running = () => o.items().filter((item) => cardStatus(item) === "running");
  const create = () => ({ label: t().codeCreateInChat, icon: "sparkles", onClick: () => props.onCreateInChat() });
  const toggle = (filter: "attention" | "paused") => o.choose(o.filter() === filter ? "all" : filter);

  return (
    <Pane
      label={t().myCode}
      status={
        <Show when={o.page()}>
          {/* k2b-ui gap (DP hero band): the hero is "n runs today" as figure 30 in Gustav's colour with the day line as
              its trend; until the band lands, the status row carries the statement and its exceptions. */}
          <StatusRow
            lead={runsToday() === null ? t().myCode : t().appsRunsToday({ count: runsToday() ?? 0 })}
            loading={o.line() === undefined}
            facts={[{ value: o.counts().all, after: t().appsFactApps }]}
            filters={
              <>
                {/* The exceptions, never the norm: what needs the person and what is paused filter the list too. */}
                <Show when={needingYou().length > 0 || o.filter() === "attention"}>
                  <Chip status="bad" pressed={o.filter() === "attention"} onClick={() => toggle("attention")}>
                    {t().appsExceptionNeedsYou({ count: needingYou().length, name: needingYou()[0]?.title ?? "" })}
                  </Chip>
                </Show>
                <Show when={running().length > 0}>
                  <Chip ai>{t().appsExceptionRunning({ count: running().length, name: running()[0]!.title })}</Chip>
                </Show>
                <Show when={o.counts().paused > 0 || o.filter() === "paused"}>
                  <Chip status="warn" pressed={o.filter() === "paused"} onClick={() => toggle("paused")}>
                    {t().appsExceptionPaused({ count: o.counts().paused })}
                  </Chip>
                </Show>
                <Button icon="sparkles" onClick={() => props.onCreateInChat()}>
                  {t().codeCreateInChat}
                </Button>
              </>
            }
          />
        </Show>
      }
    >
      <Show
        when={o.page() !== null}
        fallback={<Failed text={`${t().codeLoadFailed} ${t().codeLoadFailedHint}`} onRetry={() => void o.load()} />}
      >
        <Show
          when={!o.empty()}
          // The explanations belong to the empty state, not to every day (B: only what counts).
          fallback={<Empty icon="code" text={`${t().codeEmpty} ${t().codeEmptyHint} ${t().codeRunsAsYou}`} action={create()} />}
        >
          {/* k2b-ui gap: no v2 primitive draws a day of marks on a time axis (lane N extends the state timeline of #4233);
              v1's day line stands bare here, its runs in Gustav's soft colour, without a legend. */}
          <Canvas label={t().appsToday}>
            <CodeDay
              bare
              line={o.page() === undefined ? undefined : o.line()}
              bounds={o.dayBounds()}
              titles={o.titles()}
              timeZone={props.timeZone}
              onRetry={() => void o.completeExtras(true)}
            />
          </Canvas>
          <Table
            label={t().myCode}
            rowKey={(item) => item.id}
            rows={o.visible()}
            loading={o.page() === undefined ? { rows: 4, lines: 2 } : false}
            empty={{
              icon: "filter",
              text: t().appsFilterEmpty,
              action: { label: t().appsFilterAll({ count: o.counts().all }), onClick: () => o.choose("all") },
            }}
            open={(item) => ({ href: codeHref(item.id) })}
            columns={[
              // B rule 4: one line per row on the desktop; the schedule is a column of its own, not a second line.
              // k2b-ui gap: #4223 (Column mark): the name leads with Gustav's mark per trigger once a column can carry one;
              // until then the name stands alone on the desktop (the phone row already shows the mark).
              { title: t().appsColumnName, cell: (item) => item.title, width: { min: 160, default: 240 } },
              { title: t().appsColumnSchedule, cell: (item) => cardDescription(item, t(), locale()) },
              { title: t().appsColumnState, cell: (item) => state(cardStatus(item)), width: { min: 210, default: 210 } },
              {
                title: t().appsColumnLast,
                // The column head says "Zuletzt"; the cell says what happened, once.
                cell: (item) => cardLastText(item, cardStatus(item), t(), locale(), props.timeZone, o.now()) ?? t().codeRunUnknown,
                drop: true,
              },
              { title: t().appsColumnNext, cell: next, align: "end", width: { min: 110, default: 140 } },
              // k2b-ui gap: the runs of the last days (B rule 2) come with G's Ticks (#4353).
            ]}
            // On the phone always two lines: the name; its schedule and next run, joined with "·" (B rule 4).
            phone={(item) => ({
              lines: [item.title, [cardDescription(item, t(), locale()), next(item) === "–" ? "" : next(item)].filter(Boolean).join(" · ")],
              mark: markOf(item),
              // A state that needs the person keeps its colour on the phone too; every other one is a quiet word.
              time: CHIP_OF(cardStatus(item)) ? undefined : STATE[cardStatus(item)].word(t()),
              marks: CHIP_OF(cardStatus(item)) ? state(cardStatus(item)) : undefined,
            })}
          />
          <Show when={o.page()?.nextCursor}>
            {/* Further apps after the last row; a failed page offers the same again. */}
            <Inline>
              <Button
                variant="text"
                icon={o.more() === "failed" ? "refresh" : "chevron-down"}
                busy={o.more() === "loading"}
                onClick={() => void o.loadMore()}
              >
                {o.more() === "failed" ? t().codeLoadMoreFailed : t().codeLoadMore}
              </Button>
            </Inline>
          </Show>
        </Show>
      </Show>
    </Pane>
  );
}
