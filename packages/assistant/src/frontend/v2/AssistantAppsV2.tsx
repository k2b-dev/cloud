import { useLocale } from "@k2b/ui";
import { Band, Button, Canvas, Chip, Empty, Failed, Pane, Section, StatusRow, Table, Text } from "@k2b/ui/v2";
import { Show } from "solid-js";
import CodeDay from "../CodeDay";
import { type CodeCardStatus, type CodeOverviewItem, cardStatus } from "../code-overview";
import {
  type CodeOverviewProps,
  cardDescription,
  cardLast,
  cardWhen,
  codeHref,
  createCodeOverview,
  STATE,
  viewText,
} from "../code-overview-view";

const CHIP = { danger: "bad", warning: "warn" } as const;

/**
 * My apps & automations on v2 (screen brief 1 in the PR, recipe "overview"): one statement of today's runs with what
 * needs the person beside it, the day line under it, then one dense row per app. The same state as v1
 * (`createCodeOverview`): the filter in the address, live runs, further pages.
 */
export default function AssistantAppsV2(props: CodeOverviewProps) {
  const locale = useLocale();
  const t = () => viewText(locale());
  const o = createCodeOverview(props);
  const runsToday = () => {
    const line = o.line();
    return line ? line.succeeded + line.failed + line.running + line.planned + line.grouped : null;
  };
  // As the recipe: a state that needs the person is a chip with its dot, every other one a plain word.
  const state = (status: CodeCardStatus) => {
    const shown = STATE[status];
    return shown.tone === "danger" || shown.tone === "warning" ? <Chip status={CHIP[shown.tone]}>{shown.word(t())}</Chip> : shown.word(t());
  };
  const when = (item: CodeOverviewItem) => cardWhen(item, cardStatus(item), t(), locale(), props.timeZone, o.now());
  const create = () => ({ label: t().codeCreateInChat, icon: "sparkles", onClick: () => props.onCreateInChat() });

  return (
    <Pane
      label={t().myCode}
      status={
        <Show when={o.page()}>
          <StatusRow
            lead={runsToday() === null ? t().myCode : t().appsRunsToday({ count: runsToday() ?? 0 })}
            loading={o.line() === undefined}
            facts={[{ value: o.counts().all, after: t().appsFactApps }]}
            filters={
              <Show when={o.showsFilters()}>
                <Show when={o.counts().attention > 0 || o.filter() === "attention"}>
                  <Button
                    icon="alert-circle"
                    pressed={o.filter() === "attention"}
                    onClick={() => o.choose(o.filter() === "attention" ? "all" : "attention")}
                  >
                    {t().appsFilterAttention({ count: o.counts().attention })}
                  </Button>
                </Show>
                <Show when={o.counts().paused > 0 || o.filter() === "paused"}>
                  <Button
                    icon="player-pause"
                    pressed={o.filter() === "paused"}
                    onClick={() => o.choose(o.filter() === "paused" ? "all" : "paused")}
                  >
                    {t().appsFilterPaused({ count: o.counts().paused })}
                  </Button>
                </Show>
              </Show>
            }
          />
        </Show>
      }
    >
      <Show
        when={o.page() !== null}
        fallback={<Failed text={`${t().codeLoadFailed} ${t().codeLoadFailedHint}`} onRetry={() => void o.load()} />}
      >
        <Show when={!o.empty()} fallback={<Empty icon="code" text={`${t().codeEmpty} ${t().codeEmptyHint}`} action={create()} />}>
          <Section title={t().appsToday}>
            {/* k2b-ui gap: no v2 primitive draws a day of marks on a time axis; v1's day line stands bare here until the
                design study decides the hero's look. */}
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
          </Section>
          <Section title={t().myCode} count={o.page() ? o.visible().length : undefined} actions={[create()]} summary={t().codeRunsAsYou}>
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
                {
                  title: t().appsColumnName,
                  mark: () => ({ icon: "code" }),
                  cell: (item) => ({ lines: [item.title, cardDescription(item, t(), locale())] }),
                  width: { min: 180, default: 260 },
                  // A long name or schedule wraps instead of hiding its end, such as the last run of the day.
                  wrap: true,
                },
                { title: t().appsColumnState, cell: (item) => state(cardStatus(item)), width: { min: 210, default: 210 } },
                {
                  title: t().appsColumnLast,
                  cell: (item) => cardLast(item, cardStatus(item), t(), locale(), props.timeZone, o.now()),
                  drop: true,
                },
                { title: t().appsColumnWhen, cell: when, align: "end", width: { min: 110, default: 140 } },
                // k2b-ui gap: the runs of the last days as one dot per result (v1's DotStrip) has no public v2 part;
                // the column comes back with it.
              ]}
              phone={(item) => ({
                lines: [item.title, when(item) || cardDescription(item, t(), locale())],
                mark: { icon: "code" },
                time: STATE[cardStatus(item)].word(t()),
              })}
            />
          </Section>
          <Show when={o.page()?.nextCursor}>
            <Band>
              <Button
                variant="text"
                icon={o.more() === "failed" ? "refresh" : "chevron-down"}
                busy={o.more() === "loading"}
                onClick={() => void o.loadMore()}
              >
                {o.more() === "failed" ? t().codeLoadMoreFailed : t().codeLoadMore}
              </Button>
            </Band>
          </Show>
          <Band>
            <Text muted>{t().codeElsewhere}</Text>
          </Band>
        </Show>
      </Show>
    </Pane>
  );
}
