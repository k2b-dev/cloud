import { query } from "@k2b/stdlib/solid";
import { Avatar, Button, DetailPanel, formatFileViewSize, Placeholder, prompts, Section, toast } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import type { ActivityEntry } from "../activity-contracts";
import { apiClient } from "../api/client";
import type { BaseSummary, FileEntry, FileVersion, SharePage, ShareView } from "../contracts";
import { activityVersion } from "./activity-versions";
import { useBrowserMessages } from "./browser-messages";
import { apiFailure } from "./file-preview";
import { formatWhen, type HistoryActions, type HistoryEnvironment } from "./history-actions";
import { loadItemHistory, loadItemShares, loadShareAccess, restoreVersion, revokeShare } from "./history-api";
import { useHistoryMessages } from "./history-messages";
import { itemHistoryRequest, itemHistorySource, sharePeriod } from "./history-requests";
import ItemHistory from "./ItemHistory";
import { useFilesMessages } from "./messages";
import ShareHistory, { createShareAccess, type ShareAccessRequest } from "./ShareHistory";
import type { WorkspaceSnapshot } from "./workspace-state";

/** History in the detail: request context, the server's first page and the actions; absent hides it. */
export type InspectorHistory = {
  env: HistoryEnvironment;
  initial?: WorkspaceSnapshot["history"];
  actions: HistoryActions;
  activityHref: (baseId: string, path: string, scope: "folder" | "item") => string;
};

/**
 * The saved versions of a file, read once for the Properties count and the versions list. A second read of the file after
 * the list confirms that the list belongs to the shown file state; on a mismatch the details refresh first.
 */
export function createVersions(base: () => BaseSummary, entry: () => FileEntry, onStale: () => Promise<void>) {
  const t = useBrowserMessages();
  const key = () =>
    JSON.stringify([
      base().id,
      base().locationKey,
      entry().path,
      entry().resourceId ?? null,
      entry().modified,
      entry().size,
      entry().revision ?? null,
    ]);
  const versions = query.create({
    source: key,
    enabled: () => base().versioningEnabled && !entry().directory,
    load: async (key, { abortSignal }) => {
      const param = { baseId: base().id };
      const path = entry().path;
      const response = await apiClient.bases[":baseId"].versions.$get({ param, query: { path } }, { init: { signal: abortSignal } });
      if (!response.ok) return apiFailure(response, t().detailsFailed);
      const items = await response.json();
      const confirmed = await apiClient.bases[":baseId"].entry.$get({ param, query: { path } }, { init: { signal: abortSignal } });
      if (!confirmed.ok) return apiFailure(confirmed, t().detailsFailed);
      const result = await confirmed.json();
      return { key, items, base: result.base, file: result.entry };
    },
  });
  type Loaded = NonNullable<ReturnType<typeof versions.data>>;
  /** Match storage and file identity; revisionless storage additionally compares its available content metadata. */
  const confirms = (value: Loaded) =>
    value.key === key() &&
    value.base.id === base().id &&
    value.base.locationKey === base().locationKey &&
    value.file.path === entry().path &&
    value.file.directory === entry().directory &&
    value.file.resourceId === entry().resourceId &&
    value.file.revision === entry().revision &&
    (value.file.revision !== undefined || (value.file.modified === entry().modified && value.file.size === entry().size));
  /** A list the refreshed details still did not confirm; it shows as a failed read with Retry instead of loading forever. */
  const [unconfirmed, setUnconfirmed] = createSignal<Loaded | null>(null);
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  createEffect(() => {
    const value = versions.data();
    if (!value || untrack(() => value.key !== key() || confirms(value))) return;
    // Once per list response: the details catch up, which changes the key and reads the list again.
    void onStale().then(() => {
      if (alive && versions.data() === value && value.key === key() && !confirms(value)) setUnconfirmed(value);
    });
  });
  /** `null` until the list of this exact file state arrived; then never an empty stand-in for "unknown". */
  const items = createMemo(() => {
    const value = versions.data();
    return value && confirms(value) ? value.items : null;
  });
  const state = () =>
    !base().versioningEnabled
      ? "off"
      : versions.error() || (!versions.refreshing() && !!unconfirmed() && unconfirmed() === versions.data())
        ? "error"
        : items()
          ? "ready"
          : "loading";
  return { items, state, refreshing: versions.refreshing, refresh: () => versions.refresh() };
}
export type Versions = ReturnType<typeof createVersions>;

/**
 * Order of the detail as approved: public links, versions of a file, then the item's history. Versions and history
 * share one version list, so history rows can name "Version 2" with the number the list shows.
 */
export function EntryHistory(props: {
  base: BaseSummary;
  entry: FileEntry;
  resourceId?: string;
  busy?: boolean;
  onChanged: (selectPath?: string | null) => void;
  onOpen: (entry: FileEntry) => void;
  locale: string;
  history?: InspectorHistory;
  versions: Versions;
  currentAuthor?: string | null;
  versionsId: string;
  versionsOpen: boolean;
  onShowVersions: () => void;
}) {
  const h = useHistoryMessages();
  const t = useBrowserMessages();
  // Numbers count the saved versions, oldest first; the current content comes after them.
  const ordered = createMemo(() => [...(props.versions.items() ?? [])].sort((a, b) => a.created.localeCompare(b.created)));
  const versionNumbers = createMemo(() => new Map(ordered().map((version, index) => [version.id, index + 1])));
  const versionOf = (entry: ActivityEntry) => (props.versions.state() === "ready" ? activityVersion(entry, props.entry, ordered()) : null);
  const restorePrevious = async (entry: ActivityEntry) => {
    const previous = ordered().at(-1);
    if (!previous || !versionOf(entry)?.restorable) throw new Error(h().actionFailed);
    await restoreVersion(props.base.id, props.entry, previous.id, h().actionFailed);
    toast.success(t().versionRestored);
    props.onChanged(props.entry.path);
  };
  const request = () => itemHistoryRequest(props.base, { ...props.entry, resourceId: props.entry.resourceId ?? props.resourceId });
  const source = () => JSON.stringify([props.base.locationKey ?? null, itemHistorySource(request())]);
  const now = () => props.history?.env.now ?? new Date().toISOString();
  const period = createMemo(() => sharePeriod(now()));
  const shareSource = () =>
    JSON.stringify([props.base.id, props.base.locationKey ?? null, props.entry.path, props.entry.resourceId ?? props.resourceId ?? null]);
  // Server-side item matching precedes pagination. Never filter a user's global first page in the browser.
  const shares = query.createInfinite({
    source: shareSource,
    enabled: () => !!props.history,
    loadPage: (_key, { cursor, abortSignal }) =>
      loadItemShares({ baseId: props.base.id, path: props.entry.path }, cursor ?? null, abortSignal, h().accessFailed),
    getNextCursor: (page: SharePage) => page.next,
  });
  // The query clears its error as soon as a retry starts; keep this action's label and alert in place until it settles.
  const [shareRetrySource, setShareRetrySource] = createSignal<string | null>(null);
  const shareRetrying = () => shareRetrySource() === shareSource();
  const shareFailed = () => !!shares.error() || shareRetrying();
  const loadMoreShares = async () => {
    if (shares.loading() || shares.loadingMore() || shareRetrying()) return;
    const key = shareSource();
    if (shares.error()) setShareRetrySource(key);
    try {
      await (shares.hasMore() ? shares.loadMore() : shares.refresh());
    } finally {
      if (shareRetrySource() === key) setShareRetrySource(null);
    }
  };
  const [revoked, setRevoked] = createSignal<{ source: string; items: Map<string, ShareView> } | null>(null);
  const itemShares = createMemo(() => {
    const unique = new Map(
      shares
        .pages()
        .flatMap((page) => page.items)
        .map((share) => [share.id, share]),
    );
    const overrides = revoked()?.source === shareSource() ? revoked()?.items : null;
    return [...unique.values()].map((original) => {
      const share = overrides?.get(original.id) ?? original;
      return { share, creatorName: share.createdBy || null };
    });
  });
  const loadAccess = (request: ShareAccessRequest, signal: AbortSignal) => loadShareAccess(request, period(), signal, h().accessFailed);
  // One access query per loaded link feeds both its facts and the item's history.
  const links = createShareAccess({ shares: itemShares, period, load: loadAccess });
  const linksState = () =>
    shares.pages().length === 0 && !shareFailed() ? "loading" : shares.hasMore() || shareFailed() ? "partial" : "complete";
  const revoke = async (share: ShareView) => {
    const source = shareSource();
    const result = await revokeShare(share, t().revokeFailed);
    if (source !== shareSource()) return;
    // The fresh server result updates this row; a revoke never refetches every previously loaded page.
    const items = new Map(revoked()?.source === source ? revoked()?.items : []);
    items.set(share.id, { ...share, state: result.state });
    setRevoked({ source, items });
  };
  return (
    <>
      <Show when={props.history}>
        {(history) => (
          <>
            <ShareHistory env={history().env} shares={links()} period={period()} load={loadAccess} onRevoke={revoke} />
            <Show when={shares.loading() || shareFailed() || shares.hasMore()}>
              <div role="group" aria-label={h().publicLink}>
                <Show when={shares.loading() && !shareRetrying() && itemShares().length === 0}>
                  <p role="status">{t().loadingDetails}</p>
                </Show>
                <Show when={shareFailed()}>
                  <p class="filesv2-item-history__line" role="alert">
                    {h().accessFailed}
                  </p>
                </Show>
                <Show when={shares.hasMore() || shareFailed()}>
                  <Button
                    size="xs"
                    variant="link"
                    loading={shares.loadingMore() || shares.loading() || shareRetrying()}
                    onClick={() => void loadMoreShares()}
                  >
                    {shareFailed() ? h().retry : t().moreShares}
                    <i class={shareFailed() ? "ti ti-refresh" : "ti ti-chevron-down"} aria-hidden="true" />
                  </Button>
                </Show>
              </div>
            </Show>
          </>
        )}
      </Show>
      <Show when={!props.entry.directory}>
        {/* Phones open this list from the version count in Info; wider panels always show it. */}
        <div id={props.versionsId} class="filesv2-inspector-versions" data-open={props.versionsOpen ? "true" : undefined}>
          <VersionsSection
            base={props.base}
            entry={props.entry}
            busy={props.busy}
            onChanged={props.onChanged}
            onOpen={props.onOpen}
            locale={props.locale}
            versions={props.versions}
            currentAuthor={props.currentAuthor}
            env={props.history?.env}
            number={(version) => versionNumbers().get(version.id)}
          />
        </div>
      </Show>
      <Show when={props.history}>
        {(history) => (
          <ItemHistory
            unavailable={props.base.area === "freeipa"}
            env={history().env}
            actions={{
              ...history().actions,
              version: versionOf,
              onRestoreVersion: restorePrevious,
              ...(!props.entry.directory ? { onShowVersions: props.onShowVersions } : {}),
            }}
            directory={props.entry.directory}
            source={source()}
            initial={
              history().initial?.source === itemHistorySource(request()) ? { source: source(), page: history().initial!.page } : null
            }
            load={(cursor, signal) => loadItemHistory(request(), cursor, signal, h().historyFailed)}
            links={{ items: links(), state: linksState() }}
            activityHref={history().activityHref(props.base.id, props.entry.path, props.entry.directory ? "folder" : "item")}
            onChanged={() => props.onChanged(props.entry.path)}
          />
        )}
      </Show>
    </>
  );
}

function VersionsSection(props: {
  base: BaseSummary;
  entry: FileEntry;
  busy?: boolean;
  onChanged: (selectPath?: string | null) => void;
  onOpen: (entry: FileEntry) => void;
  locale: string;
  env?: HistoryEnvironment;
  versions: Versions;
  currentAuthor?: string | null;
  number?: (version: FileVersion) => number | undefined;
}) {
  const h = useHistoryMessages();
  const t = useBrowserMessages();
  const f = useFilesMessages();
  const [busy, setBusy] = createSignal(false);
  const items = () => props.versions.items() ?? [];
  const canAct = () => props.versions.state() === "ready" && !props.versions.refreshing();
  // Newest first, below the current file, as the approved list reads.
  const listed = createMemo(() => [...items()].sort((a, b) => b.created.localeCompare(a.created)));
  const run = async (work: () => Promise<void>) => {
    if (busy() || props.busy) return;
    if (!canAct()) {
      toast.error(h().versionsFailed);
      return;
    }
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : f().unavailable);
    } finally {
      setBusy(false);
    }
  };
  const param = () => ({ baseId: props.base.id });
  const path = () => props.entry.path;
  const comment = async (version: FileVersion) => {
    if (!canAct()) return;
    const values = await prompts.form({
      title: t().commentVersion,
      fields: {
        comment: { type: "text", label: t().versionComment, default: version.comment ?? "", maxLength: 2000, multiline: true, lines: 3 },
      },
    });
    if (!values) return;
    await run(async () => {
      const response = await apiClient.bases[":baseId"].versions.comment.$post({
        param: param(),
        json: { path: path(), id: version.id, comment: String(values.comment ?? "") },
      });
      if (!response.ok) await apiFailure(response, f().unavailable);
      toast.success(t().versionCommented);
      await props.versions.refresh();
    });
  };
  const restore = (version: FileVersion) =>
    run(async () => {
      // An in-place restore needs a server-enforced precondition; revisionless storage can restore to a new file.
      if (!props.entry.revision) throw new Error(h().versionsFailed);
      const response = await apiClient.bases[":baseId"].versions.restore.$post({
        param: param(),
        json: { path: path(), id: version.id, expectedRevision: props.entry.revision },
      });
      if (!response.ok) await apiFailure(response, f().unavailable);
      toast.success(t().versionRestored);
      props.onChanged(path());
    });
  const restoreAs = async (version: FileVersion) => {
    if (!canAct()) return;
    const dot = props.entry.name.lastIndexOf(".");
    const suggested =
      dot > 0
        ? `${props.entry.name.slice(0, dot)} (${t().versions.toLowerCase()})${props.entry.name.slice(dot)}`
        : `${props.entry.name} (${t().versions.toLowerCase()})`;
    const values = await prompts.form({
      title: t().restoreVersionAs,
      fields: { name: { type: "text", label: t().restoreAsName, default: suggested, required: true, maxLength: 255 } },
    });
    if (!values) return;
    await run(async () => {
      const response = await apiClient.bases[":baseId"].versions["restore-as"].$post({
        param: param(),
        json: { path: path(), id: version.id, name: values.name },
      });
      if (!response.ok) await apiFailure(response, f().unavailable);
      toast.success(t().versionRestored);
      props.onChanged((await response.json()).entry.path);
    });
  };
  const downloadVersion = (version: FileVersion) =>
    run(async () => {
      const response = await apiClient.bases[":baseId"].versions.download.$post({ param: param(), json: { path: path(), id: version.id } });
      if (!response.ok) await apiFailure(response, f().downloadFailed);
      const lease = await response.json();
      const link = document.createElement("a");
      link.href = lease.url;
      link.download = props.entry.name;
      link.rel = "noreferrer";
      document.body.append(link);
      link.click();
      link.remove();
    });
  const when = (iso: string) =>
    props.env
      ? formatWhen(iso, props.locale, h(), props.env)
      : new Date(iso).toLocaleString(props.locale, { dateStyle: "medium", timeStyle: "short" });
  return (
    <DetailPanel.Group label={t().versions}>
      <Section
        title={t().versions}
        icon="ti ti-versions"
        actions={
          <span class="inline-flex size-4" role="status">
            <Show when={props.versions.state() === "ready" && props.versions.refreshing()}>
              <i class="ti ti-loader-2 motion-safe:animate-spin" aria-hidden="true" />
              <span class="sr-only">{t().loadingDetails}</span>
            </Show>
          </span>
        }
        count={props.versions.state() === "ready" ? items().length + 1 : undefined}
      >
        <Show when={props.versions.state() === "error"}>
          <Placeholder
            state="error"
            align="left"
            class="px-0 py-1"
            description={h().versionsFailed}
            action={
              <Button size="xs" variant="text" onClick={() => void props.versions.refresh()}>
                {t().retry}
              </Button>
            }
          />
        </Show>
        <Switch>
          <Match when={props.versions.state() === "off"}>
            <p class="text-xs text-dimmed">{t().versionsUnavailable}</p>
          </Match>
          <Match when={props.versions.state() === "loading"}>
            <Placeholder state="loading" align="left" class="px-0 py-1" description={t().loadingDetails} />
          </Match>
          <Match when={props.versions.items() !== null}>
            <div class="flex flex-col">
              {/* The file as it is now, numbered after the saved versions as the history counts it. */}
              <DetailPanel.Action
                type="button"
                title={
                  props.versions.state() === "ready"
                    ? `${h().versionN.replace("{n}", String(items().length + 1))} · ${h().versionCurrent}`
                    : h().versionCurrent
                }
                leading={
                  <span aria-hidden="true" class="flex">
                    <Avatar
                      name={props.currentAuthor ?? h().versionCurrent}
                      icon={props.currentAuthor ? undefined : "ti ti-file"}
                      size="xs"
                      style={{ width: "20px", height: "20px" }}
                    />
                  </span>
                }
                trailing={
                  <time dateTime={props.entry.modified} title={when(props.entry.modified)}>
                    {when(props.entry.modified)}
                  </time>
                }
                disabled={props.busy}
                onClick={() => props.onOpen(props.entry)}
              />
              <For each={listed()}>
                {(version) => (
                  <DetailPanel.Action
                    type="button"
                    title={
                      props.number?.(version)
                        ? h().versionN.replace("{n}", String(props.number(version)))
                        : t().versionLabel(when(version.created))
                    }
                    description={[version.comment, version.author, formatFileViewSize(version.size, props.locale)]
                      .filter(Boolean)
                      .join(" · ")}
                    // Filegate's author metadata names the comment editor, not the content author.
                    leading={
                      <span aria-hidden="true" class="flex">
                        <Avatar name={t().versions} icon="ti ti-history" size="xs" style={{ width: "20px", height: "20px" }} />
                      </span>
                    }
                    trailing={
                      <time dateTime={version.created} title={when(version.created)}>
                        {when(version.created)}
                      </time>
                    }
                    disabled={busy() || props.busy || !canAct()}
                    onClick={() => (props.entry.actions?.write === false ? void downloadVersion(version) : void comment(version))}
                    menuLabel={`${t().actions}: ${when(version.created)}`}
                    menuItems={[
                      {
                        disabled: !canAct() || props.entry.actions?.write === false,
                        label: t().commentVersion,
                        icon: "ti ti-message",
                        action: () => void comment(version),
                      },
                      {
                        disabled: !canAct(),
                        label: t().downloadVersion,
                        icon: "ti ti-download",
                        action: () => void downloadVersion(version),
                      },
                      {
                        disabled: !canAct() || !props.entry.revision || props.entry.actions?.write === false,
                        label: t().restoreVersion,
                        description: !props.entry.revision ? t().restoreNeedsRevision : undefined,
                        icon: "ti ti-arrow-back-up",
                        action: () => void restore(version),
                      },
                      {
                        disabled: !canAct(),
                        label: t().restoreVersionAs,
                        icon: "ti ti-file-plus",
                        action: () => void restoreAs(version),
                      },
                    ]}
                  />
                )}
              </For>
            </div>
            <Show when={!items().length}>
              <p class="text-xs text-dimmed">{t().noVersions}</p>
            </Show>
          </Match>
        </Switch>
      </Section>
    </DetailPanel.Group>
  );
}
