import { type InfiniteQueryResult, query } from "@k2b/stdlib/solid";
import { Button, DetailPanel, prompts, Skeleton, toast, useLocale } from "@k2b/ui";
import { type Accessor, createMemo, createSignal, For, Match, mapArray, Show, Switch } from "solid-js";
import type { ShareAccessCounts, ShareAccessPeriod } from "../activity-contracts";
import type { ShareView } from "../contracts";
import { useBrowserMessages } from "./browser-messages";
import HistoryUnavailable, { isHistoryUnavailable } from "./HistoryUnavailable";
import { formatDate, formatTime, type HistoryEnvironment, type MetaPart } from "./history-actions";
import { type HistoryMessages, useHistoryMessages } from "./history-messages";
import { HistoryAvatar, MetaLine } from "./history-rows";

export type ShareAccessRequest = { shareId: string; networkAfter?: string; timelineAfter?: string };

export type ShareAccessLoad = (request: ShareAccessRequest, signal: AbortSignal) => Promise<ShareAccessCounts>;

/**
 * One public link with its access counts. The first page holds the link's facts and newest access periods; further
 * pages follow the timeline cursor. The facts and the item's history read this one query, so neither repeats a request.
 */
export type ShareAccess = {
  share: ShareView;
  creatorName: string | null;
  access: InfiniteQueryResult<ShareAccessCounts>;
};

/**
 * Access queries for exactly the links the parent loaded. Only shares the person created, or every share for an
 * administrator, reach this; nothing here widens it. Each link loads once when it appears; a removed link or a new
 * period aborts its request.
 */
export function createShareAccess(options: {
  shares: Accessor<readonly { share: ShareView; creatorName: string | null }[]>;
  /** Calendar dates of the counted window, inclusive; the load adds them to every request. */
  period: Accessor<{ from: string; to: string }>;
  initial?: Readonly<Record<string, ShareAccessCounts>>;
  load: ShareAccessLoad;
}): Accessor<readonly ShareAccess[]> {
  const ids = createMemo(() => options.shares().map((item) => item.share.id));
  const queries = createMemo(
    mapArray(ids, (shareId) => {
      const source = () => JSON.stringify([shareId, options.period().from, options.period().to]);
      const initial = options.initial?.[shareId];
      const access = query.createInfinite({
        source,
        initial: initial ? { source: source(), pages: [{ source: source(), page: initial }] } : undefined,
        loadPage: async (key, { cursor, abortSignal }) => ({
          source: key,
          page: await options.load(cursor ? { shareId, timelineAfter: cursor } : { shareId }, abortSignal),
        }),
        getNextCursor: (result: { source: string; page: ShareAccessCounts }) => result.page.timeline.next,
      });
      // Facts, timeline rows and cursors must all describe the current counted window.
      const pages = createMemo(() =>
        access
          .pages()
          .filter((result) => result.source === source())
          .map((result) => result.page),
      );
      return [shareId, { ...access, pages, hasMore: () => pages().at(-1)?.timeline.next != null }] as const;
    }),
  );
  return createMemo(() => {
    const byId = new Map(queries());
    return options.shares().flatMap((item) => {
      const access = byId.get(item.share.id);
      return access ? [{ ...item, access }] : [];
    });
  });
}

export type ShareHistoryProps = {
  env: HistoryEnvironment;
  shares: readonly ShareAccess[];
  /** Calendar dates of the counted window, inclusive. */
  period: { from: string; to: string };
  /** Further network pages of one link. */
  load: ShareAccessLoad;
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
        <DetailPanel.Section title={h().publicLink} tone="neutral" count={props.shares.length}>
          <div class="filesv2-share-history">
            <For each={props.shares}>
              {(item) => (
                <ShareFacts
                  share={item.share}
                  creatorName={item.creatorName}
                  access={item.access}
                  env={props.env}
                  period={props.period}
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

function ShareFacts(props: {
  share: ShareView;
  creatorName: string | null;
  access: ShareAccess["access"];
  env: HistoryEnvironment;
  period: { from: string; to: string };
  load: ShareAccessLoad;
  onRevoke?: ShareHistoryProps["onRevoke"];
}) {
  const h = useHistoryMessages();
  const b = useBrowserMessages();
  const locale = useLocale();
  const source = () => JSON.stringify([props.share.id, props.period.from, props.period.to]);
  // The first page holds the facts; older timeline pages only extend the item's history.
  const facts = {
    data: () => props.access.pages()[0],
    error: () => props.access.error(),
    refresh: () => props.access.refresh(),
  };
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
        <Match when={isHistoryUnavailable(facts.error())}>
          <HistoryUnavailable />
        </Match>
        <Match when={!facts.data() && facts.error()}>
          <p class="filesv2-item-history__line" role="alert">
            <i class="ti ti-alert-triangle" aria-hidden="true" />
            {h().accessFailed}
            <Button size="xs" variant="text" class="filesv2-history-link" onClick={() => void facts.refresh()}>
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
                  <Button size="xs" variant="text" class="filesv2-history-link" aria-expanded="false" onClick={() => setExpanded(true)}>
                    {h().moreNetworks.replace("{count}", String(unseen()))}
                  </Button>
                </Show>
                <Show when={expanded() && (next() || moreFailed())}>
                  <Button size="xs" variant="text" class="filesv2-history-link" loading={moreLoading()} onClick={() => void loadMore()}>
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

/** "18.10., 22:00 to 23:00" for an hourly bucket; a rolled-up day names the whole day. Never a request time. */
export function periodLabel(period: ShareAccessPeriod, h: HistoryMessages, locale: string, env: HistoryEnvironment) {
  const date = formatDate(period.date, locale, env);
  if (period.granularity === "day") return h.periodDay.replace("{date}", date);
  const end = new Date(Date.parse(period.date) + 3_600_000).toISOString();
  return h.periodHour
    .replace("{date}", date)
    .replace("{from}", formatTime(period.date, locale, env))
    .replace("{to}", formatTime(end, locale, env));
}

/** Whether a period holds anything to say; empty buckets stay out of the history. */
export const periodHasAccess = (period: ShareAccessPeriod) => period.pages + period.downloads + period.passwordFailed > 0;

/**
 * One access period of a public link as a history row: the link avatar, what visitors did, the bucket's time range and
 * the link. Counts and shortened networks only; a network is never a person, and the row has no action.
 */
export function AccessRow(props: { share: ShareView; period: ShareAccessPeriod; env: HistoryEnvironment }) {
  const h = useHistoryMessages();
  const locale = useLocale();
  const text = () => {
    const period = props.period;
    if (period.pages > 0) {
      const count = period.pageNetworks;
      return count === null ? h().accessPages(period.pages) : h().accessPagesNetworks({ pages: period.pages, networks: count });
    }
    if (period.downloads > 0) return h().accessDownloads.replace("{count}", String(period.downloads));
    return h().accessPasswords.replace("{count}", String(period.passwordFailed));
  };
  const meta = (): MetaPart[] => {
    const period = props.period;
    const parts: MetaPart[] = [
      { kind: "time", iso: period.date, text: periodLabel(period, h(), locale(), props.env) },
      { kind: "text", text: props.share.title ? h().linkNamed.replace("{title}", props.share.title) : h().publicLink },
    ];
    if (period.pages > 0 && period.downloads > 0)
      parts.push({ kind: "text", text: h().periodDownloads.replace("{count}", String(period.downloads)) });
    if ((period.pages > 0 || period.downloads > 0) && period.passwordFailed > 0)
      parts.push({ kind: "text", text: h().periodPasswords.replace("{count}", String(period.passwordFailed)) });
    return parts;
  };
  return (
    <article class="filesv2-history-row" data-variant="detail" data-kind="link-access">
      <HistoryAvatar actor={{ kind: "visitor", label: h().linkVisitor, person: null, agent: null, icon: "ti ti-link" }} size="xs" />
      <div class="filesv2-history-row__text">
        <p class="filesv2-history-row__sentence">{text()}</p>
        <MetaLine parts={meta()} />
      </div>
      <div class="filesv2-history-row__action" />
    </article>
  );
}
