import { query } from "@k2b/stdlib/solid";
import { Button, DetailPanel, prompts, Skeleton, toast, useLocale } from "@k2b/ui";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { ShareAccessCounts } from "../activity-contracts";
import type { ShareView } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import { formatDate, formatTime, type HistoryEnvironment } from "./history-actions";
import { useHistoryMessages } from "./history-messages";

export type ShareAccessRequest = { shareId: string; networkAfter?: string; timelineAfter?: string };

export type ShareHistoryProps = {
  env: HistoryEnvironment;
  /** Only shares the person created, or every share for an administrator. The parent decides; nothing here widens it. */
  shares: readonly { share: ShareView; creatorName: string | null }[];
  /** Calendar dates of the counted window, inclusive; the parent adds them to every request. */
  period: { from: string; to: string };
  initial?: Readonly<Record<string, ShareAccessCounts>>;
  load: (request: ShareAccessRequest, signal: AbortSignal) => Promise<ShareAccessCounts>;
  /** Existing revoke action; without it the button is not shown. */
  onRevoke?: (share: ShareView) => Promise<void>;
};

/** "203.0.113.0/24" reads "203.0.113.x"; "2001:db8:4f2::/48" reads "2001:db8:4f2::". A network is never a person. */
export const networkLabel = (network: string) =>
  network.endsWith(".0/24") ? `${network.slice(0, -5)}.x` : network.endsWith("/48") ? network.slice(0, -3) : network;

const NETWORK_ROWS = 3;

/** Public link facts for its creator and administrators: page views, released downloads and shortened networks. */
export default function ShareHistory(props: ShareHistoryProps) {
  const h = useHistoryMessages();
  return (
    <Show when={props.shares.length > 0}>
      <DetailPanel.Group label={h().publicLink}>
        <DetailPanel.Section title={h().publicLink} icon="ti ti-world-share" tone="neutral" count={props.shares.length}>
          <div class="filesv2-share-history">
            <For each={props.shares}>
              {(item) => (
                <ShareFacts
                  share={item.share}
                  creatorName={item.creatorName}
                  env={props.env}
                  period={props.period}
                  initial={props.initial?.[item.share.id]}
                  load={props.load}
                  onRevoke={props.onRevoke}
                />
              )}
            </For>
          </div>
        </DetailPanel.Section>
      </DetailPanel.Group>
    </Show>
  );
}

type Network = ShareAccessCounts["networks"]["items"][number];
type Period = ShareAccessCounts["timeline"]["items"][number];
const PERIOD_ROWS = 3;

function ShareFacts(props: {
  share: ShareView;
  creatorName: string | null;
  env: HistoryEnvironment;
  period: { from: string; to: string };
  initial?: ShareAccessCounts;
  load: ShareHistoryProps["load"];
  onRevoke?: ShareHistoryProps["onRevoke"];
}) {
  const h = useHistoryMessages();
  const b = useBrowserMessages();
  const locale = useLocale();
  const source = () => JSON.stringify([props.share.id, props.period.from, props.period.to]);
  const facts = query.create({
    source,
    initial: props.initial ? { source: source(), data: props.initial } : undefined,
    load: (_key, { abortSignal }) => props.load({ shareId: props.share.id }, abortSignal),
  });
  // Further network pages, most used first as the reader orders them; a network is never a person.
  const [more, setMore] = createSignal<{ source: string; items: Network[]; next: string | null } | null>(null);
  const [moreLoading, setMoreLoading] = createSignal(false);
  const [moreFailed, setMoreFailed] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [revoking, setRevoking] = createSignal(false);
  const [revokeError, setRevokeError] = createSignal<string | null>(null);
  const days = () => Math.round((Date.parse(props.period.to) - Date.parse(props.period.from)) / 86_400_000) + 1;
  const state = () => {
    if (props.share.state === "revoked") return h().revoked;
    if (props.share.state === "expired") return h().expired;
    return props.share.expiresAt ? h().validUntil.replace("{date}", formatDate(props.share.expiresAt, locale(), props.env)) : h().noExpiry;
  };
  const byline = () => [props.creatorName ? h().byCreator.replace("{name}", props.creatorName) : null, state()].filter(Boolean).join(" · ");
  const extra = () => (more()?.source === source() ? more() : null);
  const loaded = (): Network[] => [...(facts.data()?.networks.items ?? []), ...(extra()?.items ?? [])];
  const next = () => (extra() ? extra()!.next : (facts.data()?.networks.next ?? null));
  const shown = () => (expanded() ? loaded() : loaded().slice(0, NETWORK_ROWS));
  const unseen = () => Math.max((facts.data()?.networks.known ?? 0) - NETWORK_ROWS, 0);
  const loadMore = async () => {
    const cursor = next();
    if (!cursor || moreLoading()) return;
    const key = source();
    setMoreLoading(true);
    setMoreFailed(false);
    try {
      const page = await props.load({ shareId: props.share.id, networkAfter: cursor }, new AbortController().signal);
      if (key !== source()) return;
      setMore({ source: key, items: [...(extra()?.items ?? []), ...page.networks.items], next: page.networks.next });
    } catch {
      if (key === source()) setMoreFailed(true);
    } finally {
      setMoreLoading(false);
    }
  };
  // Access over time: the reader's newest UTC buckets, more on request; one page of 50 at a time.
  const [olderPeriods, setOlderPeriods] = createSignal<{ source: string; items: Period[]; next: string | null } | null>(null);
  const [periodsExpanded, setPeriodsExpanded] = createSignal(false);
  const [periodsLoading, setPeriodsLoading] = createSignal(false);
  const [periodsFailed, setPeriodsFailed] = createSignal(false);
  const olderPeriodPage = () => (olderPeriods()?.source === source() ? olderPeriods() : null);
  const periods = (): Period[] => [...(facts.data()?.timeline.items ?? []), ...(olderPeriodPage()?.items ?? [])];
  const periodsNext = () => (olderPeriodPage() ? olderPeriodPage()!.next : (facts.data()?.timeline.next ?? null));
  const shownPeriods = () => (periodsExpanded() ? periods() : periods().slice(0, PERIOD_ROWS));
  const loadOlderPeriods = async () => {
    const cursor = periodsNext();
    if (!cursor || periodsLoading()) return;
    const key = source();
    setPeriodsLoading(true);
    setPeriodsFailed(false);
    try {
      const page = await props.load({ shareId: props.share.id, timelineAfter: cursor }, new AbortController().signal);
      if (key !== source()) return;
      setOlderPeriods({ source: key, items: [...(olderPeriodPage()?.items ?? []), ...page.timeline.items], next: page.timeline.next });
    } catch {
      if (key === source()) setPeriodsFailed(true);
    } finally {
      setPeriodsLoading(false);
    }
  };
  const periodLabel = (period: Period) => {
    const date = formatDate(period.date, locale(), props.env);
    if (period.granularity === "day") return date;
    const end = new Date(Date.parse(period.date) + 3_600_000).toISOString();
    return h()
      .periodHour.replace("{date}", date)
      .replace("{from}", formatTime(period.date, locale(), props.env))
      .replace("{to}", formatTime(end, locale(), props.env));
  };
  const revoke = async () => {
    if (!props.onRevoke || revoking()) return;
    const confirmed = await prompts.confirm(b().revokeQuestion, { title: h().revokeLink, variant: "danger", confirmText: b().revoke });
    if (!confirmed) return;
    setRevoking(true);
    setRevokeError(null);
    try {
      await props.onRevoke(props.share);
      toast.success(b().revoked);
    } catch (error) {
      setRevokeError(error instanceof Error && error.message ? error.message : b().revokeFailed);
    } finally {
      setRevoking(false);
    }
  };
  return (
    <div class="filesv2-share-facts">
      <p class="filesv2-share-facts__title">
        <strong>{props.share.title}</strong>
        <span>{byline()}</span>
      </p>
      <Switch>
        <Match when={!facts.data() && facts.error()}>
          <p class="filesv2-item-history__line" role="alert">
            <i class="ti ti-alert-triangle" aria-hidden="true" />
            {h().accessFailed}
            <Button size="xs" variant="text" onClick={() => void facts.refresh()}>
              {h().retry}
            </Button>
          </p>
        </Match>
        <Match when={!facts.data()}>
          <p class="sr-only" role="status">
            {h().accessLoading}
          </p>
          <div class="filesv2-share-facts__skeleton" aria-hidden="true">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
        </Match>
        <Match when={facts.data()}>
          {(data) => (
            <>
              {/* Flat figures as approved: the number above its label, no cards. */}
              <dl class="filesv2-share-facts__stats">
                <div>
                  <dt>{h().pageViews}</dt>
                  <dd>{data().pages}</dd>
                </div>
                <div>
                  <dt>{h().downloadsReleased}</dt>
                  <dd>{data().downloads}</dd>
                </div>
                <div>
                  <dt>{h().networks}</dt>
                  <dd>
                    {data().networks.overflow
                      ? h().moreThanNetworks.replace("{count}", String(data().networks.known))
                      : data().networks.known}
                  </dd>
                </div>
              </dl>
              <p class="filesv2-share-facts__sentence">
                {data().pageNetworks === null
                  ? h().pageViewsSentence.replace("{pages}", String(data().pages))
                  : h().pageNetworksSentence.replace("{pages}", String(data().pages)).replace("{networks}", String(data().pageNetworks))}
              </p>
              <p class="filesv2-share-facts__note">{h().periodNote.replace("{days}", String(days()))}</p>
              <Show when={data().networks.incomplete}>
                <p class="filesv2-share-facts__note">{h().networksIncomplete}</p>
              </Show>
              <Show when={data().passwordFailed > 0}>
                <p class="filesv2-share-facts__note">{h().wrongPasswords.replace("{count}", String(data().passwordFailed))}</p>
              </Show>
              <Show when={shown().length > 0}>
                <ul class="filesv2-share-facts__networks">
                  <For each={shown()}>
                    {(row, index) => (
                      <li>
                        <code>{networkLabel(row.network)}</code>
                        <span>
                          {(index() === 0 ? h().netSince : h().netCount)
                            .replace("{date}", formatDate(row.firstSeen, locale(), props.env))
                            .replace("{count}", String(row.pages))}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={!expanded() && unseen() > 0}>
                  <Button size="xs" variant="text" aria-expanded="false" onClick={() => setExpanded(true)}>
                    {h().moreNetworks.replace("{count}", String(unseen()))}
                  </Button>
                </Show>
                <Show when={expanded() && (next() || moreFailed())}>
                  <Button size="xs" variant="text" loading={moreLoading()} onClick={() => void loadMore()}>
                    {moreFailed() ? h().retry : h().loadMoreNetworks}
                  </Button>
                </Show>
                <Show when={moreFailed()}>
                  <p class="filesv2-item-history__line" role="alert">
                    <i class="ti ti-alert-triangle" aria-hidden="true" />
                    {h().accessFailed}
                  </p>
                </Show>
              </Show>
              <Show when={periods().length > 0}>
                <p class="filesv2-share-facts__subtitle">{h().accessOverTime}</p>
                <ul class="filesv2-share-facts__periods">
                  <For each={shownPeriods()}>
                    {(period) => (
                      <li>
                        <time datetime={period.date}>{periodLabel(period)}</time>
                        <span>
                          {h().periodCounts.replace("{pages}", String(period.pages)).replace("{downloads}", String(period.downloads))}
                          <Show when={period.knownNetworks !== null}>
                            {` · ${h().periodNetworks.replace("{count}", String(period.knownNetworks))}`}
                          </Show>
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={!periodsExpanded() && periods().length > PERIOD_ROWS}>
                  <Button size="xs" variant="text" aria-expanded="false" onClick={() => setPeriodsExpanded(true)}>
                    {h().showOlderUnknown}
                  </Button>
                </Show>
                <Show when={(periodsExpanded() || periods().length <= PERIOD_ROWS) && (periodsNext() || periodsFailed())}>
                  <Button size="xs" variant="text" loading={periodsLoading()} onClick={() => void loadOlderPeriods()}>
                    {periodsFailed() ? h().retry : h().loadOlderAccess}
                  </Button>
                </Show>
                <Show when={periodsFailed()}>
                  <p class="filesv2-item-history__line" role="alert">
                    <i class="ti ti-alert-triangle" aria-hidden="true" />
                    {h().accessFailed}
                  </p>
                </Show>
              </Show>
            </>
          )}
        </Match>
      </Switch>
      <Show when={props.onRevoke && props.share.state === "active"}>
        <div class="filesv2-share-facts__revoke">
          <Button size="sm" variant="secondary" loading={revoking()} onClick={() => void revoke()}>
            <i class="ti ti-link-off" aria-hidden="true" />
            {h().revokeLink}
          </Button>
        </div>
      </Show>
      <Show when={revokeError()}>
        {(message) => (
          <p class="filesv2-history-row__error" role="alert">
            {message()}
          </p>
        )}
      </Show>
    </div>
  );
}
