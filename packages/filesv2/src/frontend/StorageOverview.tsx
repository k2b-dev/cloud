import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { query } from "@k2b/stdlib/solid";
import {
  AppOverview,
  AppWorkspace,
  Button,
  ButtonLink,
  FileDropTarget,
  FileTypeIcon,
  InlineGuidance,
  LinkCard,
  PanelHeader,
  Placeholder,
  Skeleton,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import type { BaseSummary, BasesResult, MarkedEntry } from "../contracts";
import { activityDays } from "./ActivityView";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { favoritePlace } from "./FavoritesPage";
import { DirectoryStatus, IssueMessage } from "./feedback";
import { type HistoryEnvironment, historyRows } from "./history-actions";
import { loadActivity, loadFavorites, loadRecent } from "./history-api";
import { useHistoryMessages } from "./history-messages";
import { HistoryRow, HistoryRunRow, OpenedRow, SkeletonRows } from "./history-rows";
import { useFilesMessages } from "./messages";
import { activityUrl, filesUrl } from "./urls";

/** The overview shows this many favorites; the page lists all of them. */
export const FAVORITES_PREVIEW = 6;
const RECENT_LINES = 5;

function Section(props: { icon: string; title: string; count?: number; action?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="filesv2-overview__section">
      <PanelHeader
        size="sm"
        title={
          <span class="filesv2-overview__title">
            <i class={props.icon} aria-hidden="true" />
            {props.title}
            <Show when={props.count !== undefined}>
              <span class="filesv2-overview__count">{props.count}</span>
            </Show>
          </span>
        }
        actions={props.action}
      />
      {props.children}
    </section>
  );
}

/**
 * "All storage": favorites first (the server sends up to six with the first frame, so nothing below moves), then the
 * storage locations as flat entries, then the last few things this person did. Each part fails and retries alone.
 */
export default function StorageOverview(props: {
  bases: BaseSummary[];
  issues: BasesResult["issues"];
  /** Authorized favorites preview from the server; `null` when it failed, undefined when it was not read. */
  favorites: { items: MarkedEntry[]; more: boolean } | null | undefined;
  env: HistoryEnvironment;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
}) {
  const b = useBrowserMessages();
  const t = useFilesMessages();
  const h = useHistoryMessages();
  const locale = useLocale();
  const labels = () => props.bases.map((base) => ({ id: base.id, label: baseLabel(base, b(), locale()) }));
  const [openRun, setOpenRun] = createSignal<string | null>(null);
  const favorites = query.create({
    source: () => "favorites-preview",
    initial: props.favorites ? { source: "favorites-preview", data: props.favorites } : undefined,
    load: async (_, { abortSignal }) => {
      const items = await loadFavorites(abortSignal, b().favoritesFailed);
      return { items: items.slice(0, FAVORITES_PREVIEW), more: items.length > FAVORITES_PREVIEW };
    },
  });
  // Changes and opened files of this person, merged like Activity's "Me"; loaded after the first frame, below the fold.
  const recent = query.create({
    source: () => "recent-by-you",
    load: async (_, { abortSignal }) => {
      const [page, opened] = await Promise.all([
        loadActivity({ actor: "me", limit: String(RECENT_LINES) }, abortSignal, b().recentFailed),
        loadRecent(abortSignal, b().recentFailed).catch(() => [] as MarkedEntry[]),
      ]);
      const days = activityDays(historyRows(page.items, { batches: true, merge: true }), opened, {
        complete: !page.next,
        locale: locale(),
        t: h(),
        env: props.env,
      });
      return days.flatMap((day) => day.items).slice(0, RECENT_LINES);
    },
  });
  return (
    <AppWorkspace.Main scroll class="filesv2-browser">
      {/* Files are uploaded inside a storage location; a file dropped here is refused rather than opened by the browser. */}
      <FileDropTarget label={b().allStorage} disabled onDrop={() => {}} />
      <div class="filesv2-overview">
        <Section
          icon="ti ti-star"
          title={b().favorites}
          action={
            <Show when={favorites.data()?.items.length}>
              <ButtonLink size="sm" variant="text" href={`/app/filesv2?view=favorites`} navigation="enhanced" onNavigate={props.onNavigate}>
                {b().showAllFavorites}
              </ButtonLink>
            </Show>
          }
        >
          <Switch>
            <Match when={favorites.error() && !favorites.data()}>
              <Placeholder
                variant="inline"
                align="left"
                state="error"
                description={b().favoritesFailed}
                action={
                  <Button size="sm" variant="text" onClick={() => void favorites.refresh()}>
                    {b().retry}
                  </Button>
                }
              />
            </Match>
            <Match when={!favorites.data()}>
              <AppOverview.Cards surface="plain" class="filesv2-overview__favorites">
                <For each={Array.from({ length: FAVORITES_PREVIEW }, (_, index) => index)}>
                  {() => <Skeleton class="filesv2-overview__skeleton-card" />}
                </For>
              </AppOverview.Cards>
            </Match>
            <Match when={favorites.data()!.items.length === 0}>
              <Placeholder variant="inline" align="left" icon="ti ti-star" description={b().noFavoritesInline} />
            </Match>
            <Match when={favorites.data()!.items.length > 0}>
              <AppOverview.Cards surface="plain" class="filesv2-overview__favorites">
                <For each={favorites.data()!.items}>
                  {(item) => (
                    <LinkCard
                      surface="plain"
                      href={
                        item.entry.directory
                          ? filesUrl(item.base.id, item.entry.path)
                          : filesUrl(item.base.id, item.entry.path.split("/").slice(0, -1).join("/"), null, item.entry.path)
                      }
                      navigation="enhanced"
                      onNavigate={props.onNavigate}
                      title={item.entry.name}
                      description={favoritePlace(item, labels())}
                      media={<FileTypeIcon name={item.entry.name} folder={item.entry.directory} />}
                    />
                  )}
                </For>
              </AppOverview.Cards>
            </Match>
          </Switch>
        </Section>
        <Section icon="ti ti-folders" title={b().storageSection} count={props.bases.length}>
          <For each={props.issues}>
            {(issue) => (
              <InlineGuidance tone="info">
                <strong>{t()[issue.area]}: </strong>
                <IssueMessage code={issue.code} />
              </InlineGuidance>
            )}
          </For>
          <nav aria-label={b().allStorage}>
            <AppOverview.Cards surface="plain">
              <For each={props.bases}>
                {(base) => (
                  <LinkCard
                    surface="plain"
                    href={filesUrl(base.id)}
                    navigation="enhanced"
                    onNavigate={props.onNavigate}
                    title={baseLabel(base, b(), locale())}
                    icon={base.kind === "users" ? "ti ti-home" : "ti ti-users"}
                    description={
                      base.kind === "users" ? `${b().onlyYou} · ${base.name} · ${t()[base.area]}` : `${t().group} · ${t()[base.area]}`
                    }
                    meta={base.status !== "existing" ? <DirectoryStatus status={base.status} /> : undefined}
                  />
                )}
              </For>
            </AppOverview.Cards>
          </nav>
          <p class="filesv2-overview__hint">{b().createInStorage}</p>
        </Section>
        <Section
          icon="ti ti-history"
          title={b().recentByYou}
          action={
            <ButtonLink size="sm" variant="text" href={activityUrl({ actor: "me" })} navigation="enhanced" onNavigate={props.onNavigate}>
              {b().showAllActivity}
            </ButtonLink>
          }
        >
          <Switch>
            <Match when={recent.error() && !recent.data()}>
              <Placeholder
                variant="inline"
                align="left"
                state="error"
                description={b().recentFailed}
                action={
                  <Button size="sm" variant="text" onClick={() => void recent.refresh()}>
                    {b().retry}
                  </Button>
                }
              />
            </Match>
            <Match when={!recent.data()}>
              <p class="sr-only" role="status">
                {h().loading}
              </p>
              <SkeletonRows count={RECENT_LINES} variant="compact" />
            </Match>
            <Match when={recent.data()!.length === 0}>
              <Placeholder variant="inline" align="left" icon="ti ti-history" description={b().noRecentByYou} />
            </Match>
            <Match when={recent.data()!.length > 0}>
              <ul class="filesv2-history-rows filesv2-overview__recent">
                <For each={recent.data()}>
                  {(line) => (
                    <li>
                      <Switch>
                        <Match when={line.item.kind === "row" && line.item}>
                          {(single) => (
                            <HistoryRow
                              row={single().row}
                              env={props.env}
                              context="activity"
                              dated={false}
                              variant="compact"
                              mode="me"
                              links
                            />
                          )}
                        </Match>
                        <Match when={line.item.kind === "run" && line.item}>
                          {(run) => (
                            <HistoryRunRow
                              rows={run().rows}
                              env={props.env}
                              mode="me"
                              links
                              expanded={openRun() === run().key}
                              onToggle={(open) => setOpenRun(open ? run().key : null)}
                            />
                          )}
                        </Match>
                        <Match when={line.item.kind === "opened" && line.item}>
                          {(file) => <OpenedRow item={file().item} env={props.env} bases={labels()} when="relative" />}
                        </Match>
                      </Switch>
                    </li>
                  )}
                </For>
              </ul>
            </Match>
          </Switch>
        </Section>
      </div>
    </AppWorkspace.Main>
  );
}
