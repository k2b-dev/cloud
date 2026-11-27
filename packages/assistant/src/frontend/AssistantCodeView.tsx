import { FeatCodeMark } from "@k2b/cloud/code/ui";
import {
  AppOverview,
  Button,
  DotStrip,
  type DotStripTone,
  FilterToggle,
  LinkCard,
  Placeholder,
  ScrollArea,
  Skeleton,
  useLocale,
} from "@k2b/ui";
import { For, Show } from "solid-js";
import CodeDay from "./CodeDay";
import { type CodeCardRun, type CodeCardStatus, type CodeOverviewItem, cardStatus } from "./code-overview";
import {
  type CodeOverviewProps,
  cardDescription,
  cardLast,
  cardWhen,
  codeHref,
  createCodeOverview,
  STATE,
  viewText,
} from "./code-overview-view";

const runTone = (run: CodeCardRun): DotStripTone =>
  run.state === "succeeded"
    ? "success"
    : run.state === "failed" || run.state === "cancelled"
      ? "danger"
      : run.state === "skipped"
        ? "muted"
        : "running";
/** v1's state chips: the shared tone and word, with Tabler's class. */
const STATUS = (status: CodeCardStatus) => ({ ...STATE[status], icon: `ti ti-${STATE[status].icon}` });

function CodeCard(props: { item: CodeOverviewItem; timeZone: string; now: Date }) {
  const locale = useLocale();
  const t = () => viewText(locale());
  const status = () => cardStatus(props.item);
  const shown = () => STATUS(status());
  // Oldest left, newest right, as on the Code page.
  const runs = () => [...(props.item.extras?.runs ?? [])].reverse();
  const runsLabel = () =>
    t().appsRuns({
      count: runs().length,
      succeeded: runs().filter((run) => run.state === "succeeded").length,
      failed: runs().filter((run) => run.state === "failed" || run.state === "cancelled").length,
    });
  return (
    <LinkCard
      href={codeHref(props.item.id)}
      title={props.item.title}
      description={cardDescription(props.item, t(), locale())}
      media={
        <span class="assistant-apps__tile" aria-hidden="true">
          <FeatCodeMark variant="glyph" tone="current" size={16} decorative />
        </span>
      }
      aside={
        <Show when={runs().length > 0}>
          <DotStrip variant="bar" dots={runs().map(runTone)} label={runsLabel()} class="assistant-apps__bars" />
        </Show>
      }
      body={
        <span class="assistant-apps__card-last">
          <i class="ti ti-arrow-forward-up" aria-hidden="true" />
          <Show when={props.item.extras} fallback={<Skeleton class="assistant-apps__card-last-skeleton" />}>
            <span>{cardLast(props.item, status(), t(), locale(), props.timeZone, props.now)}</span>
          </Show>
        </span>
      }
      footer={{
        start: (
          <span class="assistant-apps__state" data-tone={shown().tone}>
            <i class={shown().icon} aria-hidden="true" />
            {shown().word(t())}
          </span>
        ),
        end: <span class="assistant-apps__card-when">{cardWhen(props.item, status(), t(), locale(), props.timeZone, props.now)}</span>,
      }}
    />
  );
}

function CardSkeleton() {
  return (
    <div class="k2b-paper assistant-apps__card" aria-hidden="true">
      <span class="assistant-apps__card-top">
        <Skeleton class="assistant-apps__tile" />
        <span class="assistant-apps__card-copy">
          <Skeleton class="h-3.5 w-3/5" />
          <Skeleton class="h-3 w-2/5" />
        </span>
      </span>
      <span class="assistant-apps__card-last">
        <Skeleton class="assistant-apps__card-last-skeleton" />
      </span>
      <span class="assistant-apps__card-foot">
        <Skeleton class="h-3 w-1/3" />
        <Skeleton class="h-3 w-1/4" />
      </span>
    </div>
  );
}

/**
 * "My apps & automations": only the person's own Code, which runs as them. Code of a place stays at that place.
 * `initial` is the server's first page (null when it failed); without it, the list loads when the view opens. Items
 * without card extras get them in the browser, bounded by the page.
 */
export default function AssistantCodeView(props: CodeOverviewProps) {
  const locale = useLocale();
  const t = () => viewText(locale());
  const o = createCodeOverview(props);
  const { page, more, filter, now, load, loadMore, completeExtras, counts, showsFilters, visible, choose, line, dayBounds, titles, empty } =
    o;

  const createButton = () => (
    <Button type="button" variant="ai" onClick={() => props.onCreateInChat()}>
      <i class="ti ti-sparkles" aria-hidden="true" />
      {t().codeCreateInChat}
    </Button>
  );

  return (
    <ScrollArea class="min-h-0 flex-1">
      <section class="assistant-apps" aria-labelledby="assistant-apps-title">
        <header class="assistant-page-head">
          <div class="assistant-page-head__copy">
            <h1 id="assistant-apps-title" class="assistant-page-head__title">
              {t().myCode}
            </h1>
            <p class="assistant-page-head__lead">{t().codeRunsAsYou}</p>
          </div>
          <Show when={!empty()}>{createButton()}</Show>
        </header>
        <Show
          when={page() !== undefined}
          fallback={
            <div class="assistant-apps__body" role="status" aria-busy="true" aria-label={t().codeViewLoading}>
              <CodeDay line={undefined} bounds={null} titles={titles()} timeZone={props.timeZone} onRetry={() => {}} />
              <AppOverview.Cards class="assistant-apps__cards">
                <For each={[0, 1, 2, 3]}>{() => <CardSkeleton />}</For>
              </AppOverview.Cards>
            </div>
          }
        >
          <Show
            when={page()}
            fallback={
              <Placeholder
                state="error"
                variant="panel"
                icon="ti ti-cloud-off"
                title={t().codeLoadFailed}
                description={t().codeLoadFailedHint}
                onRetry={() => void load()}
              />
            }
          >
            {(current) => (
              <Show
                when={current().items.length > 0}
                fallback={
                  <Placeholder
                    variant="panel"
                    icon="ti ti-code"
                    title={t().codeEmpty}
                    description={t().codeEmptyHint}
                    action={createButton()}
                  />
                }
              >
                <div class="assistant-apps__body">
                  <CodeDay
                    line={line()}
                    bounds={dayBounds()}
                    titles={titles()}
                    timeZone={props.timeZone}
                    onRetry={() => void completeExtras(true)}
                  />
                  <Show when={showsFilters()}>
                    <div class="assistant-apps__filters" role="group" aria-label={t().appsFilters}>
                      <FilterToggle
                        icon="ti ti-layout-grid"
                        label={t().appsFilterAll({ count: counts().all })}
                        active={filter() === "all"}
                        onClick={() => choose("all")}
                      />
                      <Show when={counts().attention > 0 || filter() === "attention"}>
                        <FilterToggle
                          icon="ti ti-alert-circle"
                          label={t().appsFilterAttention({ count: counts().attention })}
                          active={filter() === "attention"}
                          onClick={() => choose("attention")}
                        />
                      </Show>
                      <Show when={counts().paused > 0 || filter() === "paused"}>
                        <FilterToggle
                          icon="ti ti-player-pause"
                          label={t().appsFilterPaused({ count: counts().paused })}
                          active={filter() === "paused"}
                          onClick={() => choose("paused")}
                        />
                      </Show>
                    </div>
                  </Show>
                  <Show when={visible().length > 0} fallback={<p class="assistant-apps__quiet">{t().appsFilterEmpty}</p>}>
                    <AppOverview.Cards class="assistant-apps__cards">
                      <For each={visible()}>{(item) => <CodeCard item={item} timeZone={props.timeZone} now={now()} />}</For>
                    </AppOverview.Cards>
                  </Show>
                  <Show when={current().nextCursor}>
                    <div class="assistant-apps__more">
                      <Button type="button" variant="secondary" size="sm" loading={more() === "loading"} onClick={() => void loadMore()}>
                        {t().codeLoadMore}
                      </Button>
                      <Show when={more() === "failed"}>
                        <span role="alert" class="assistant-apps__more-failed">
                          {t().codeLoadMoreFailed}
                        </span>
                      </Show>
                    </div>
                  </Show>
                  <p class="assistant-apps__quiet">
                    <i class="ti ti-info-circle" aria-hidden="true" />
                    <span>{t().codeElsewhere}</span>
                  </p>
                </div>
              </Show>
            )}
          </Show>
        </Show>
      </section>
    </ScrollArea>
  );
}
