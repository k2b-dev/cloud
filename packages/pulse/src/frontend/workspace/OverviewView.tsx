import { dates } from "@k2b/stdlib";
import { Button, ButtonLink, Chart, Format, Skeleton } from "@k2b/ui";
import { createComputed, createMemo, createUniqueId, For, Match, on, Show, Switch } from "solid-js";
import type { pulseMessages } from "../../messages";
import type { Overview, OverviewActivity, OverviewAttention } from "../../overview-contracts";
import { usePulseMessages } from "../use-messages";

type Messages = ReturnType<typeof pulseMessages.resolve>["t"];
type Tile = Overview["numbers"][number];

export type OverviewViewProps = {
  data: Overview | null;
  loading: boolean;
  error: { code: string; message: string } | null;
  canWrite: boolean;
  retry: () => void;
  addSource: () => void;
  openSource: (reference: string) => void;
  openAlert: (reference: string) => void;
  askAssistant: () => void;
  assistantPending: boolean;
  assistantError: string | null;
  loadAttention: () => void;
  loadActivity: () => void;
  paging: boolean;
};

// Codes are protocol values; raw server messages are not localized UI copy.
const reason = (code: string | null, t: Messages): string => {
  switch (code) {
    case "NO_DATA":
      return t.overviewNoData;
    case "INVALID_COLUMNS":
      return t.overviewInvalidColumns;
    case "INVALID_KEY":
      return t.overviewInvalidKey;
    case "DUPLICATE_KEY":
      return t.overviewDuplicateKey;
    case "INVALID_VALUE":
      return t.overviewInvalidValue;
    case "TOO_MANY_KEYS":
      return t.overviewTooManyKeys;
    case "OVERDUE":
      return t.overviewOverdue;
    case "SQL_ERROR":
      return t.sqlError;
    case "TIME_LIMIT":
      return t.sqlTimeLimit;
    case "MEMORY_LIMIT":
      return t.sqlMemoryLimit;
    case "RESULT_TOO_LARGE":
      return t.sqlResultTooLarge;
    case "INPUT_TOO_LARGE":
      return t.sqlInputTooLargeTitle;
    case "PARAMETER_MISSING":
      return t.sqlParameterMissing;
    case "BUSY":
      return t.overviewBusy;
    case "QUEUE_FULL":
      return t.overviewQueueFull;
    case "QUOTA":
      return t.overviewQuota;
    case "STORE_UNAVAILABLE":
      return t.sqlStoreUnavailable;
    case "NO_READ_ACCESS":
      return t.sqlNoReadAccess;
    case "CANCELLED":
      return t.sqlCancelled;
    default:
      return code ? t.overviewUnknownError({ code }) : t.overviewEvaluationFailed;
  }
};

const alertState = (state: unknown, severity: unknown, t: Messages): string | null => {
  switch (state) {
    case "ok":
      return t.overviewStateOk;
    case "pending":
      return t.overviewStatePending;
    case "firing":
      return severity === "critical" ? t.overviewCritical : severity === "warn" ? t.overviewWarning : t.overviewFiring;
    case "no_data":
      return t.overviewNoData;
    case "error":
      return t.overviewStateError;
    default:
      return null;
  }
};

function OverviewAttentionRow(props: {
  item: OverviewAttention;
  timezone: string;
  openSource: OverviewViewProps["openSource"];
  openAlert: OverviewViewProps["openAlert"];
}) {
  const t = usePulseMessages();
  const danger = () => props.item.state === "error" || props.item.severity === "critical";
  const stateLabel = () => (props.item.state === "stale" ? t().overviewStale : alertState(props.item.state, props.item.severity, t()));
  return (
    <li class="pulse-overview__attention-row" data-tone={danger() ? "danger" : "warning"}>
      <i
        class={`ti ${props.item.kind === "source" ? "ti-hourglass" : "ti-alert-triangle"} pulse-overview__attention-icon`}
        aria-hidden="true"
      />
      <div class="pulse-overview__attention-copy">
        <div class="pulse-overview__attention-title">
          <bdi>{props.item.name}</bdi>
          <Show when={props.item.key !== null}>
            <span>
              {" "}
              · <bdi>{props.item.key}</bdi>
            </span>
          </Show>
          <span class="pulse-overview__level">{stateLabel()}</span>
        </div>
        <div class="pulse-overview__reason">
          <Switch>
            <Match when={props.item.kind === "source"}>
              <Show when={props.item.newestDataAt} fallback={t().overviewNoSourceData}>
                {(at) => (
                  <>
                    {t().overviewNewestValue} <Format.DateTime value={at()} timeZone={props.timezone} />
                  </>
                )}
              </Show>
              <Show when={props.item.expectDailyBy}>
                {(by) => <> · {t().overviewExpectedDaily({ time: by(), timezone: props.timezone })}</>}
              </Show>
              <Show when={props.item.expectEverySeconds}>
                {(seconds) => (
                  <>
                    {" "}
                    · {t().overviewExpectedInterval} <Format.DurationMs value={seconds() * 1000} />
                  </>
                )}
              </Show>
            </Match>
            <Match when={props.item.state === "firing"}>
              <Show when={props.item.value !== null}>
                {t().overviewValue} <Format.Number value={props.item.value} />
              </Show>
              <Show when={props.item.threshold !== null && props.item.comparison !== null}>
                {" · "}
                {props.item.comparison === "above" ? t().overviewAbove : t().overviewBelow} <Format.Number value={props.item.threshold} />
              </Show>
            </Match>
            <Match when={props.item.state === "no_data"}>{t().overviewNoDataReason}</Match>
            <Match when={props.item.state === "error"}>{reason(props.item.errorCode, t())}</Match>
          </Switch>
          {" · "}
          {t().overviewSince} <Format.DateTime value={props.item.since} timeZone={props.timezone} />
          <Show when={props.item.lastCheckedAt}>
            {(at) => (
              <>
                {" "}
                · {t().overviewChecked} <Format.DateTime value={at()} timeZone={props.timezone} />
              </>
            )}
          </Show>
        </div>
      </div>
      <div class="pulse-overview__attention-action">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => (props.item.kind === "source" ? props.openSource(props.item.reference) : props.openAlert(props.item.reference))}
        >
          {props.item.kind === "source" ? t().overviewOpenSource : t().overviewViewAlert}
        </Button>
      </div>
    </li>
  );
}

function OverviewNumberTile(props: { tile: Tile; timezone: string; unavailable: boolean }) {
  const t = usePulseMessages();
  const id = createUniqueId();
  const showTime = () => props.unavailable || props.tile.status !== "ready";
  const times = () => (
    <Show when={props.tile.lastGood}>
      {(good) => (
        <>
          {t().overviewCalculated} <Format.DateTime value={good().evaluatedAt} timeZone={props.timezone} />
          <Show when={good().data.valueAt}>
            {(at) => (
              <>
                <br />
                {t().overviewValueAt} <Format.DateTime value={at()} timeZone={props.timezone} />
              </>
            )}
          </Show>
        </>
      )}
    </Show>
  );
  const status = () => {
    switch (props.tile.status) {
      case "ready":
        return "";
      case "refreshing":
        return t().overviewNumberRefreshing;
      case "deferred":
        return t().overviewNumberDeferred;
      case "no_data":
        return t().overviewNoDataReason;
      case "error":
        return reason(props.tile.errorCode, t());
    }
  };
  return (
    <div class="pulse-overview__number">
      <dt class="pulse-overview__number-label">
        <bdi aria-describedby={props.tile.lastGood ? `${id}-time` : undefined}>{props.tile.name}</bdi>
      </dt>
      <dd class="pulse-overview__number-body">
        <Show
          when={props.tile.lastGood}
          fallback={
            <>
              <div class="pulse-overview__value">
                <span aria-hidden="true">—</span>
                <span class="sr-only">{t().overviewNoLastGood}</span>
              </div>
              <div class="pulse-overview__detail">{t().overviewNoLastGood}</div>
              <div class="pulse-overview__spark-missing">{t().overviewNoTrend}</div>
            </>
          }
        >
          {(good) => (
            <>
              <div class="pulse-overview__value">
                <Format.Number value={good().data.value} />
                <Show when={good().data.unit}>
                  <small>
                    <bdi>{good().data.unit}</bdi>
                  </small>
                </Show>
              </div>
              <div class="pulse-overview__detail" data-tone={good().data.detailTone}>
                <bdi>{good().data.detail}</bdi>
              </div>
              <Show when={good().data.points.length >= 2} fallback={<div class="pulse-overview__spark-missing">{t().overviewNoTrend}</div>}>
                <Chart
                  kind="sparkline"
                  class="pulse-overview__spark"
                  style={{ height: "30px", color: "var(--pulse-overview-trend)" }}
                  data={good().data.points}
                  smooth={false}
                  area={false}
                  showLast={false}
                  showMinMax={false}
                  labels={{ interactiveChart: t().overviewTrendLabel({ name: props.tile.name }), series: props.tile.name }}
                />
              </Show>
              <p id={`${id}-time`} class={showTime() ? "pulse-overview__number-time" : "sr-only"}>
                {times()}
              </p>
              <Show when={good().data.truncated}>
                <p class="pulse-overview__reason">{t().overviewTruncated}</p>
              </Show>
            </>
          )}
        </Show>
        <Show when={props.tile.status !== "ready"}>
          <div class="pulse-overview__number-status" data-tone={props.tile.status === "error" ? "danger" : "neutral"}>
            {status()}
            <Show when={props.tile.lastAttemptAt}>
              {(at) => (
                <>
                  <br />
                  {t().overviewLastAttempt} <Format.DateTime value={at()} timeZone={props.timezone} />
                </>
              )}
            </Show>
            <br />
            {t().overviewNextRefresh} <Format.DateTime value={props.tile.nextRefreshAt} timeZone={props.timezone} />
          </div>
        </Show>
      </dd>
    </div>
  );
}

// Activity JSON is data, never HTML, Markdown or a message-key lookup.
const textField = (data: OverviewActivity["data"], key: string): string | null => {
  const value = data[key];
  return typeof value === "string" ? value : null;
};
const activityText = (item: OverviewActivity, t: Messages): string => {
  const name = textField(item.data, "name") ?? t.overviewUnnamed;
  switch (item.kind) {
    case "source.created":
      return t.overviewActivitySourceCreated({ name });
    case "source.updated":
      return t.overviewActivitySourceUpdated({ name });
    case "source.removed":
      return t.overviewActivitySourceRemoved({ name });
    case "query_saved":
      return t.overviewActivityQuerySaved({ name });
    case "query_deleted":
      return t.overviewActivityQueryDeleted({ name });
    case "alert_saved":
      return t.overviewActivityAlertSaved({ name });
    case "alert_deleted":
      return t.overviewActivityAlertDeleted({ name });
    case "alert_transition": {
      const state = alertState(item.data.state, item.data.severity, t);
      return state ? t.overviewActivityAlertState({ name, state }) : t.overviewActivityAlertChanged({ name });
    }
    case "source_freshness": {
      const source = textField(item.data, "sourceName") ?? t.overviewUnnamed;
      return item.data.stale === true
        ? t.overviewActivitySourceStale({ name: source })
        : item.data.stale === false
          ? t.overviewActivitySourceCurrent({ name: source })
          : t.overviewActivitySourceFreshness({ name: source });
    }
    default:
      return t.overviewActivityUnknown({ kind: item.kind });
  }
};

function OverviewActivityRow(props: { item: OverviewActivity; timezone: string; readAt: string }) {
  const t = usePulseMessages();
  const sameDay = () => {
    const context = { locale: "en", timeZone: props.timezone };
    return dates.formatDateKey(props.item.at, context) === dates.formatDateKey(props.readAt, context);
  };
  // A transition may have changed keys even when the rule's summary stayed the same.
  const changedKeys = () => {
    const keys = props.item.kind === "alert_transition" ? props.item.data.keys : null;
    if (!Array.isArray(keys)) return [];
    return keys.flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null || !("key" in entry) || typeof entry.key !== "string" || !("state" in entry))
        return [];
      const state = alertState(entry.state, "severity" in entry ? entry.severity : null, t());
      return state ? [t().overviewActivityKeyState({ key: entry.key, state })] : [];
    });
  };
  return (
    <li class="pulse-overview__activity-row">
      <Show
        when={sameDay()}
        fallback={
          <Format.Date
            class="pulse-overview__activity-time"
            value={props.item.at}
            timeZone={props.timezone}
            title={`${props.item.at} (${props.timezone})`}
          />
        }
      >
        <Format.Time
          class="pulse-overview__activity-time"
          value={props.item.at}
          timeZone={props.timezone}
          title={`${props.item.at} (${props.timezone})`}
        />
      </Show>
      <div class="pulse-overview__activity-copy">
        <span>{activityText(props.item, t())}</span>
        <Show when={props.item.actor}>
          {(actor) => (
            <>
              {" · "}
              {actor().kind === "user" ? t().overviewActorPerson : t().overviewActorService} <bdi>{actor().name}</bdi>
            </>
          )}
        </Show>
        <Show when={changedKeys().length > 0}>
          <div class="pulse-overview__reason">{changedKeys().join(" · ")}</div>
        </Show>
      </div>
    </li>
  );
}

export default function OverviewView(props: OverviewViewProps) {
  const t = usePulseMessages();
  const id = createUniqueId();
  const denied = () => props.error?.code === "FORBIDDEN" || props.error?.code === "NOT_FOUND" || props.error?.code === "NO_READ_ACCESS";
  // Defense in depth: never render even an accidentally retained protected snapshot.
  const data = createMemo(() => (denied() ? null : props.data));
  let attentionList: HTMLUListElement | undefined;
  let attentionHeading: HTMLHeadingElement | undefined;
  // A keyed row can still lose browser focus when Solid moves its DOM node.
  // Computations run before DOM effects, even after repeated refreshes.
  // Restore the surviving action, next surviving neighbor, previous one, or
  // heading only if focus fell to the body; never override another target.
  createComputed(
    on(
      () => data()?.attention.items,
      () => {
        const list = attentionList;
        const focused = list?.ownerDocument.activeElement;
        if (!list || !(focused instanceof HTMLElement) || !list.contains(focused)) return;
        const actions = [...list.querySelectorAll("button")];
        const position = actions.findIndex((button) => button === focused);
        queueMicrotask(() => {
          if (!list.isConnected || list.ownerDocument.activeElement !== list.ownerDocument.body) return;
          const neighbors = [...actions.slice(position + 1), ...actions.slice(0, position).reverse()];
          const target =
            focused.isConnected && list.contains(focused)
              ? focused
              : (neighbors.find((button) => button.isConnected && list.contains(button)) ?? attentionHeading);
          target?.focus({ preventScroll: true });
        });
      },
      { defer: true },
    ),
  );
  const empty = () => {
    const snapshot = data();
    return !!snapshot && snapshot.sources.total === 0 && snapshot.attention.total === 0 && snapshot.numbers.length === 0;
  };
  const unavailable = () => !!data()?.storeUnavailable || props.error?.code === "STORE_UNAVAILABLE";
  const assistant = () => (
    <Button
      class="pulse-workspace__desktop-action"
      variant="ai"
      loading={props.assistantPending}
      loadingLabel={t().sqlAssistantLaunching}
      onClick={props.askAssistant}
    >
      <i class="ti ti-sparkles" aria-hidden="true" /> {t().sqlAskAssistant}
    </Button>
  );
  return (
    <section class="pulse-overview" aria-label={t().overview} data-print-region>
      <Switch>
        <Match when={denied()}>
          <div class="pulse-overview__state">
            <i class="ti ti-lock pulse-overview__state-icon" aria-hidden="true" />
            <h2>{props.error?.code === "NOT_FOUND" ? t().overviewNotFoundTitle : t().overviewNoAccessTitle}</h2>
            <p>{t().overviewNoAccessHint}</p>
            <div class="pulse-overview__actions">
              <ButtonLink href="/app/pulse" variant="secondary">
                {t().overviewBackToBases}
              </ButtonLink>
            </div>
          </div>
        </Match>
        <Match when={!data() && props.loading}>
          <div class="pulse-overview__toolbar" aria-hidden="true" />
          <div class="pulse-overview__band" role="status">
            <span class="pulse-overview__dot" />
            {t().overviewLoading}
          </div>
          <div aria-hidden="true" class="pulse-overview__loading">
            <Skeleton class="pulse-overview__skeleton-heading" />
            <div class="pulse-overview__attention">
              <Skeleton class="pulse-overview__skeleton-row" />
              <Skeleton class="pulse-overview__skeleton-row" />
            </div>
            <Skeleton class="pulse-overview__skeleton-section" />
            <div class="pulse-overview__numbers">
              <For each={[0, 1, 2, 3]}>
                {() => (
                  <div>
                    <Skeleton class="pulse-overview__skeleton-label" />
                    <Skeleton class="pulse-overview__skeleton-value" />
                    <Skeleton class="pulse-overview__skeleton-detail" />
                    <Skeleton class="pulse-overview__skeleton-spark" />
                  </div>
                )}
              </For>
            </div>
            <Skeleton class="pulse-overview__skeleton-section" />
            <Skeleton class="pulse-overview__skeleton-activity" />
            <Skeleton class="pulse-overview__skeleton-activity" />
          </div>
        </Match>
        <Match when={!data()}>
          <div class="pulse-overview__state" role="alert">
            <i class="ti ti-alert-circle pulse-overview__state-icon" aria-hidden="true" />
            <h2>{unavailable() ? t().sqlStoreUnavailable : t().overviewLoadFailed}</h2>
            <p>{unavailable() ? t().overviewNoSnapshot : t().overviewLoadFailedHint}</p>
            <div class="pulse-overview__actions">
              <Button variant="secondary" onClick={props.retry} loading={props.loading}>
                {t().retry}
              </Button>
            </div>
          </div>
        </Match>
        <Match when={data()}>
          <Show when={data()}>
            {(snapshot) => (
              <>
                <div class="pulse-overview__toolbar">
                  <Show when={!empty()}>
                    <div class="pulse-overview__assistant-desktop">{assistant()}</div>
                  </Show>
                  <div class="pulse-overview__assistant-feedback" role="status">
                    <Show when={props.assistantError}>
                      <span>
                        {t().overviewAssistantFailed} {props.assistantError}
                      </span>
                    </Show>
                  </div>
                </div>
                <div class="pulse-overview__band" data-tone={props.error || unavailable() ? "danger" : "neutral"}>
                  <span
                    class="pulse-overview__dot"
                    data-tone={
                      props.error || unavailable()
                        ? "danger"
                        : snapshot().sources.total === 0
                          ? "neutral"
                          : snapshot().sources.current === snapshot().sources.total
                            ? "success"
                            : "warning"
                    }
                    aria-hidden="true"
                  />
                  <div class="pulse-overview__band-copy" role="status">
                    <Show
                      when={props.error || unavailable()}
                      fallback={
                        <Show
                          when={snapshot().sources.total > 0}
                          fallback={
                            <>
                              <strong>{t().overviewNoSources}</strong> · {t().overviewFirstValues}
                            </>
                          }
                        >
                          <strong>
                            <Format.Number value={snapshot().sources.current} /> {t().overviewOf}{" "}
                            <Format.Number value={snapshot().sources.total} /> {t().overviewSourcesCurrent}
                          </strong>
                          {" · "}
                          {t().overviewAsOf}{" "}
                          <Format.Time
                            value={snapshot().readAt}
                            timeZone={snapshot().timezone}
                            title={`${snapshot().readAt} (${snapshot().timezone})`}
                          />{" "}
                          · {t().overviewEveryMinute}
                        </Show>
                      }
                    >
                      <strong>{unavailable() ? t().sqlStoreUnavailable : t().overviewRefreshFailed}</strong>
                      {" · "}
                      {t().overviewMetadataAsOf} <Format.DateTime value={snapshot().readAt} timeZone={snapshot().timezone} />
                      {" · "}
                      {snapshot().numbers.some((tile) => tile.lastGood !== null) ? t().overviewValuesDatedBelow : t().overviewNoLastGood}
                    </Show>
                    <Show when={props.loading}> · {t().overviewRefreshing}</Show>
                  </div>
                  <Show when={props.error || unavailable()}>
                    <Button variant="secondary" size="sm" loading={props.loading} disabled={props.paging} onClick={props.retry}>
                      {t().retry}
                    </Button>
                  </Show>
                </div>
                <Show
                  when={!empty()}
                  fallback={
                    <div class="pulse-overview__state">
                      <i class="ti ti-activity-heartbeat pulse-overview__state-icon" aria-hidden="true" />
                      <h2>{t().overviewEmptyTitle({ base: snapshot().name })}</h2>
                      <p>{t().overviewEmptyHint}</p>
                      <div class="pulse-overview__actions">
                        <Show when={props.canWrite}>
                          <Button onClick={props.addSource}>
                            <i class="ti ti-plus" aria-hidden="true" /> {t().overviewCreateSource}
                          </Button>
                        </Show>
                        {assistant()}
                      </div>
                      <Show when={!props.canWrite}>
                        <p>{t().overviewEmptyReadOnly}</p>
                      </Show>
                    </div>
                  }
                >
                  <h2 ref={attentionHeading} tabIndex={-1} id={`${id}-attention`} class="pulse-overview__headline" aria-live="polite">
                    {snapshot().attention.total === 0 ? (
                      t().overviewQuiet
                    ) : snapshot().attention.total === 1 ? (
                      t().overviewAttentionOne
                    ) : (
                      <>
                        <Format.Number value={snapshot().attention.total} /> {t().overviewAttentionMany}
                      </>
                    )}
                  </h2>
                  <ul ref={attentionList} class="pulse-overview__attention" aria-labelledby={`${id}-attention`}>
                    {/* Stable domain IDs keep existing actions mounted across snapshot refreshes. */}
                    <For each={snapshot().attention.items.map((item) => item.id)}>
                      {(itemId) => (
                        <Show when={snapshot().attention.items.find((item) => item.id === itemId)}>
                          {(item) => (
                            <OverviewAttentionRow
                              item={item()}
                              timezone={snapshot().timezone}
                              openSource={props.openSource}
                              openAlert={props.openAlert}
                            />
                          )}
                        </Show>
                      )}
                    </For>
                  </ul>
                  <Show when={snapshot().attention.nextOffset !== null}>
                    <div class="pulse-overview__paging">
                      <span>
                        {t().overviewShown} <Format.Number value={snapshot().attention.items.length} /> {t().overviewOf}{" "}
                        <Format.Number value={snapshot().attention.total} />
                      </span>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={props.loading}
                        loading={props.paging}
                        loadingLabel={t().overviewLoadingMore}
                        onClick={props.loadAttention}
                      >
                        {t().overviewMoreAttention}
                      </Button>
                    </div>
                  </Show>
                  <h3 id={`${id}-numbers`} class="pulse-overview__section-title">
                    {t().overviewNumbers}
                  </h3>
                  <Show when={snapshot().numbers.length > 0} fallback={<p class="pulse-overview__hint">{t().overviewNoPins}</p>}>
                    <dl class="pulse-overview__numbers" aria-labelledby={`${id}-numbers`}>
                      <For each={snapshot().numbers.map((tile) => tile.queryId)}>
                        {(queryId) => (
                          <Show when={snapshot().numbers.find((tile) => tile.queryId === queryId)}>
                            {(tile) => (
                              <OverviewNumberTile
                                tile={tile()}
                                timezone={snapshot().timezone}
                                unavailable={unavailable() || props.error !== null}
                              />
                            )}
                          </Show>
                        )}
                      </For>
                    </dl>
                  </Show>
                </Show>
                <Show when={!empty() || snapshot().activity.items.length > 0 || snapshot().activity.nextCursor !== null}>
                  <h3 id={`${id}-activity`} class="pulse-overview__section-title">
                    {t().overviewRecentChanges}
                  </h3>
                  <Show when={snapshot().activity.items.length > 0} fallback={<p class="pulse-overview__hint">{t().overviewNoActivity}</p>}>
                    <ol class="pulse-overview__activity" aria-labelledby={`${id}-activity`}>
                      <For each={snapshot().activity.items.map((item) => item.id)}>
                        {(itemId) => (
                          <Show when={snapshot().activity.items.find((item) => item.id === itemId)}>
                            {(item) => <OverviewActivityRow item={item()} timezone={snapshot().timezone} readAt={snapshot().readAt} />}
                          </Show>
                        )}
                      </For>
                    </ol>
                  </Show>
                  <Show when={snapshot().activity.nextCursor !== null}>
                    <div class="pulse-overview__paging">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={props.loading}
                        loading={props.paging}
                        loadingLabel={t().overviewLoadingMore}
                        onClick={props.loadActivity}
                      >
                        {t().overviewMoreActivity}
                      </Button>
                    </div>
                  </Show>
                </Show>
                <div class="pulse-overview__paging-status" role="status">
                  <Show when={props.paging}>{t().overviewLoadingMore}</Show>
                </div>
              </>
            )}
          </Show>
        </Match>
      </Switch>
    </section>
  );
}
