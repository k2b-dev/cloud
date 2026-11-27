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
 * then one row per app: its name over its schedule and last run, its state and its next run. Explanations stand in the empty state only. The same state as v1
 * (`createCodeOverview`): the filter in the address, live runs, further pages.
 */
// Creating in the chat is the page head's action (AssistantPageFrame), so the view takes no callback for it.
export default function AssistantAppsV2(props: Omit<CodeOverviewProps, "onCreateInChat">) {
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
  const toggle = (filter: "attention" | "paused") => o.choose(o.filter() === filter ? "all" : filter);

  return (
    <Pane
      label={t().myCode}
      status={
        <Show when={o.page()}>
          {/* k2b-ui gap: StatusRow end on the phone (R): v2 hides a status row's end below 768 px, so the exception
              chips (and their filters) are not there on the phone. "Im Chat erstellen" stands in the page's head instead
              (a "+" menu as the floating button needs `Workspace primary` to take a menu). */}
          {/* k2b-ui gap: #4360 (Hero): the hero is "n runs today" as figure 30 in Gustav's colour with the day line as
              its trend; until the band lands, the status row carries the statement and its exceptions. */}
          <StatusRow
            // The hero and its day line are one region: while the day is read, the day line alone shows it.
            lead={runsToday() === null ? t().myCode : t().appsRunsToday({ count: runsToday() ?? 0 })}
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
          // "Im Chat erstellen" stands in the head, so the empty state explains and offers nothing twice.
          fallback={<Empty icon="code" text={`${t().codeEmpty} ${t().codeEmptyHint} ${t().codeRunsAsYou}`} />}
        >
          {/* k2b-ui gap: #4344: no v2 primitive draws a day of marks on a time axis (it extends the state timeline of #4233);
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
              // Three columns that keep their words from 1024 px on: what runs and how (its schedule and what it did
              // last, as the name's second line), whether it needs the person, and when it runs next. Five columns cut
              // nearly every cell at 1024 (v13 review).
              // k2b-ui gap: #4223 (Column mark): the name leads with Gustav's mark per trigger once a column can carry one;
              // until then the name stands alone on the desktop (the phone row already shows the mark).
              {
                title: t().appsColumnName,
                cell: (item) => ({
                  lines: [
                    item.title,
                    `${cardDescription(item, t(), locale())} · ${cardLastText(item, cardStatus(item), t(), locale(), props.timeZone, o.now()) ?? t().codeRunUnknown}`,
                  ],
                }),
              },
              { title: t().appsColumnState, cell: (item) => state(cardStatus(item)), width: { min: 200, default: 200 } },
              { title: t().appsColumnNext, cell: next, align: "end", width: { min: 120, default: 140 } },
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
