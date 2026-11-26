import { query } from "@k2b/stdlib/solid";
import { formatFileViewSize, prompts, toast } from "@k2b/ui";
import { Bar, Section as Group, List, Menu, Notice, Row, Text } from "@k2b/ui/v2";
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
import { createShareAccess, type ShareAccessRequest } from "./ShareHistory";
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
/**
 * The item's public links, as the detail shows them and its history counts their access: the server's pages of the
 * person's own links for this item, one access query per link over the counted window, and their revocation.
 */
export function createEntryLinks(props: {
  base: () => BaseSummary;
  entry: () => FileEntry;
  resourceId: () => string | undefined;
  history: () => InspectorHistory | undefined;
}) {
  const h = useHistoryMessages();
  const t = useBrowserMessages();
  const now = () => props.history()?.env.now ?? new Date().toISOString();
  const period = createMemo(() => sharePeriod(now()));
  const shareSource = () =>
    JSON.stringify([
      props.base().id,
      props.base().locationKey ?? null,
      props.entry().path,
      props.entry().resourceId ?? props.resourceId() ?? null,
    ]);
  // Server-side item matching precedes pagination. Never filter a user's global first page in the browser.
  const shares = query.createInfinite({
    source: shareSource,
    enabled: () => !!props.history(),
    loadPage: (_key, { cursor, abortSignal }) =>
      loadItemShares({ baseId: props.base().id, path: props.entry().path }, cursor ?? null, abortSignal, h().accessFailed),
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
  return {
    items: links,
    state: linksState,
    period,
    loadAccess,
    revoke,
    /** The list itself: loading its first page, a failed page, or more pages to read. */
    list: () => ({
      loading: shares.loading() && !shareRetrying() && itemShares().length === 0,
      failed: shareFailed(),
      more: shares.hasMore() || shareFailed(),
      busy: shares.loadingMore() || shares.loading() || shareRetrying(),
      label: shareFailed() ? h().retry : t().moreShares,
    }),
    loadMore: loadMoreShares,
  };
}
export type EntryLinks = ReturnType<typeof createEntryLinks>;

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
  onShowVersions: () => void;
  /** The item's public links (see `createEntryLinks`): their access feeds the history's lines too. */
  links: EntryLinks;
}) {
  const h = useHistoryMessages();
  const t = useBrowserMessages();
  // Numbers count the saved versions, oldest first; the current content comes after them.
  const ordered = createMemo(() => [...(props.versions.items() ?? [])].sort((a, b) => a.created.localeCompare(b.created)));
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
  return (
    <>
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
            links={{ items: props.links.items(), state: props.links.state() }}
            activityHref={history().activityHref(props.base.id, props.entry.path, props.entry.directory ? "folder" : "item")}
            onChanged={() => props.onChanged(props.entry.path)}
          />
        )}
      </Show>
    </>
  );
}

export function EntryVersions(props: {
  base: BaseSummary;
  entry: FileEntry;
  busy?: boolean;
  onChanged: (selectPath?: string | null) => void;
  onOpen: (entry: FileEntry) => void;
  locale: string;
  env?: HistoryEnvironment;
  versions: Versions;
  currentAuthor?: string | null;
}) {
  const h = useHistoryMessages();
  const t = useBrowserMessages();
  const f = useFilesMessages();
  const [busy, setBusy] = createSignal(false);
  const items = () => props.versions.items() ?? [];
  const canAct = () => props.versions.state() === "ready" && !props.versions.refreshing();
  // Newest first, below the current file, as the approved list reads; numbered oldest first, as the history counts them.
  const listed = createMemo(() => [...items()].sort((a, b) => b.created.localeCompare(a.created)));
  const number = (version: FileVersion) => listed().length - listed().indexOf(version);
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
  const label = (version: FileVersion) => h().versionN.replace("{n}", String(number(version)));
  const writable = () => props.entry.actions?.write !== false;
  return (
    <Group icon="versions" title={t().versions} count={props.versions.state() === "ready" ? items().length + 1 : undefined}>
      <Switch>
        <Match when={props.versions.state() === "error"}>
          <Notice tone="bad" actions={[{ label: t().retry, onClick: () => void props.versions.refresh() }]}>
            {h().versionsFailed}
          </Notice>
        </Match>
        <Match when={props.versions.state() === "off"}>
          <Bar start={<Text type="meta">{t().versionsUnavailable}</Text>} />
        </Match>
        <Match when={props.versions.state() === "loading"}>
          <Bar start={<Text type="meta">{t().loadingDetails}</Text>} />
        </Match>
        <Match when={props.versions.items() !== null}>
          <List label={t().versions}>
            {/* the file as it is now, numbered after the saved versions as the history counts it */}
            <Row
              mark={{ icon: "file" }}
              lines={[
                props.versions.state() === "ready"
                  ? `${h().versionN.replace("{n}", String(items().length + 1))} · ${h().versionCurrent}`
                  : h().versionCurrent,
                [props.currentAuthor, when(props.entry.modified)].filter(Boolean).join(" · "),
              ]}
              onOpen={props.busy ? undefined : () => props.onOpen(props.entry)}
            />
            <For each={listed()}>
              {(version) => (
                <Row
                  mark={{ icon: "history" }}
                  // Filegate's author metadata names the comment editor, not the content author.
                  lines={[
                    label(version),
                    [version.comment, version.author, formatFileViewSize(version.size, props.locale), when(version.created)]
                      .filter(Boolean)
                      .join(" · "),
                  ]}
                  onOpen={
                    busy() || props.busy || !canAct()
                      ? undefined
                      : () => (writable() ? void comment(version) : void downloadVersion(version))
                  }
                  end={
                    <Menu
                      label={`${t().actions}: ${label(version)}`}
                      items={[
                        {
                          label: t().commentVersion,
                          icon: "message",
                          disabled: !canAct() || !writable(),
                          onClick: () => void comment(version),
                        },
                        {
                          label: t().downloadVersion,
                          icon: "download",
                          disabled: !canAct(),
                          onClick: () => void downloadVersion(version),
                        },
                        {
                          // an in-place restore needs the file's revision; without it the copy below still works
                          label: t().restoreVersion,
                          icon: "arrow-back-up",
                          disabled: !canAct() || !props.entry.revision || !writable(),
                          onClick: () => void restore(version),
                        },
                        { label: t().restoreVersionAs, icon: "file-plus", disabled: !canAct(), onClick: () => void restoreAs(version) },
                      ]}
                    />
                  }
                />
              )}
            </For>
          </List>
          <Show when={!items().length}>
            <Bar start={<Text type="meta">{t().noVersions}</Text>} />
          </Show>
        </Match>
      </Switch>
    </Group>
  );
}
