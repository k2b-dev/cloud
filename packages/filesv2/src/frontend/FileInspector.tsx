import { cloudResourceClipboard } from "@k2b/cloud/browser/resource-clipboard";
import { clipboard, query } from "@k2b/stdlib/solid";
import { Button, DescriptionList, DetailPanel, Format, IconButton, Placeholder, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ActivityEntry } from "../activity-contracts";
import { apiClient } from "../api/client";
import type { BaseSummary, EntryResult, FileEntry, FileVersion, SharePage, ShareView } from "../contracts";
import { ENTRY_TYPE, entryRefId } from "../resource-ref";
import type { InspectorHistory } from "./Browser";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import FilePreview from "./FilePreview";
import FileThumbnail from "./FileThumbnail";
import { apiFailure, contentLease, fileIcon, inlinePdfHref, previewKind } from "./file-preview";
import { loadItemHistory, loadItemShares, loadShareAccess, restoreVersion, revokeShare } from "./history-api";
import { useHistoryMessages } from "./history-messages";
import { itemHistoryRequest, itemHistorySource, sharePeriod } from "./history-requests";
import ItemHistory from "./ItemHistory";
import { useFilesMessages } from "./messages";
import ShareHistory from "./ShareHistory";
import { referenceHref } from "./urls";

/** Identity, quick preview, facts, actions and versions of one entry; a summary for several. */
export default function FileInspector(props: {
  base: BaseSummary;
  cloudUrl: string;
  selected: readonly FileEntry[];
  paths: readonly string[];
  initial?: EntryResult | null;
  busy?: boolean;
  onClose: () => void;
  onMarksChanged?: () => void;
  onOpen: (entry: FileEntry) => void;
  /** Opens the large preview; `onNotPdf` reports a `.pdf` whose bytes are no PDF. */
  onPreview: (entry: FileEntry, onNotPdf?: () => void) => void;
  /** Files Collabora can open; the primary action then edits instead of previewing. */
  editable?: (entry: FileEntry) => boolean;
  canEdit?: boolean;
  onDownload: (entries: readonly FileEntry[]) => void;
  onRename: (entry: FileEntry) => void;
  onDuplicate: (entry: FileEntry) => void;
  onMove: (entry: FileEntry) => void;
  onCopy: (entry: FileEntry) => void;
  onTrash: (entry: FileEntry) => void;
  onShare?: (entry: FileEntry) => void;
  onShareInbox?: (entry: FileEntry) => void;
  onChanged: (selectPath?: string | null) => void;
  history?: InspectorHistory;
}) {
  const t = useBrowserMessages();
  const f = useFilesMessages();
  const identity = (path: string) => JSON.stringify([props.base.id, props.base.locationKey, path]);
  const [favoriteOverride, setFavoriteOverride] = createSignal<{ key: string; favorite: boolean } | null>(null);
  const [favoritePending, setFavoritePending] = createSignal<string | null>(null);
  let alive = true;
  onCleanup(() => {
    alive = false;
  });
  const favorite = (item: FileEntry) =>
    favoriteOverride()?.key === source() ? favoriteOverride()!.favorite : (details.data()?.result.favorite ?? false);
  const toggleFavorite = async (entry: FileEntry, value: boolean) => {
    const baseId = props.base.id;
    const key = identity(entry.path);
    if (favoritePending()) return;
    setFavoritePending(key);
    try {
      const response = await apiClient.bases[":baseId"].favorite.$post({ param: { baseId }, json: { path: entry.path, favorite: value } });
      if (!response.ok) await apiFailure(response, f().unavailable);
      const result = await response.json();
      props.onMarksChanged?.();
      if (!alive || identity(entry.path) !== key || props.paths[0] !== entry.path) return;
      setFavoriteOverride({ key: source(), favorite: result.favorite ?? value });
      toast.success(value ? t().favoriteAdded : t().favoriteRemoved);
    } catch (error) {
      if (alive && identity(entry.path) === key) toast.error(error instanceof Error ? error.message : f().unavailable);
    } finally {
      if (alive) setFavoritePending(null);
    }
  };
  const locale = useLocale();
  const source = () =>
    JSON.stringify([
      props.base.id,
      props.base.locationKey,
      props.paths.length === 1 ? props.paths[0] : null,
      props.selected.find((entry) => entry.path === props.paths[0])?.modified,
    ]);
  const initial =
    props.initial && props.initial.base.id === props.base.id && props.paths.length === 1 && props.initial.entry.path === props.paths[0]
      ? { source: source(), data: { key: source(), result: props.initial } }
      : undefined;
  const details = query.create({
    source,
    initial,
    enabled: () => props.paths.length === 1,
    load: async (key, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"].entry.$get(
        { param: { baseId: props.base.id }, query: { path: props.paths[0]! } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) return apiFailure(response, t().detailsFailed);
      return { key, result: await response.json() };
    },
  });
  const entry = () => (details.data()?.key === source() && !details.error() ? details.data()?.result.entry : null);
  const revision = (file: FileEntry) => JSON.stringify([props.base.id, props.base.locationKey, file.path, file.modified]);
  // The preview reads a `.pdf` anyway; once its bytes show it is no PDF, the viewer tab would only open an error page.
  const [notPdf, setNotPdf] = createSignal<string | null>(null);
  const refClipboard = clipboard.createWriter({ write: cloudResourceClipboard.write, copiedFor: 1800 });
  const copyReference = (item: FileEntry) => {
    const id = item.resourceId ?? details.data()?.result.resourceId ?? entryRefId(props.base.id, item.path);
    if (!id) return;
    const href = referenceHref(props.base.id, item, id);
    void refClipboard.copy({ cloudUrl: props.cloudUrl, ref: { type: ENTRY_TYPE, id }, fallbackText: new URL(href, props.cloudUrl).href });
  };
  const copyLabel = () =>
    refClipboard.error() ? t().copyReferenceFailed : refClipboard.wasCopied() ? t().copiedReference : t().copyReference;
  const openInTab = async (item: FileEntry) => {
    // A PDF opens at the preview's page address, so its tab reloads and signs an expired session in again.
    if (previewKind(item) === "pdf") return void window.open(inlinePdfHref(props.base.id, item.path), "_blank", "noopener");
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const lease = await contentLease(props.base.id, item.path, new AbortController().signal, f().downloadFailed);
      if (tab) tab.location.href = lease.url;
      else window.open(lease.url, "_blank", "noopener");
    } catch (error) {
      tab?.close();
      toast.error(error instanceof Error ? error.message : f().downloadFailed);
    }
  };
  const kindLabel = (item: FileEntry) => {
    if (item.directory) return t().kindFolder;
    const kind = previewKind(item);
    return kind === "image"
      ? t().kindImage
      : kind === "pdf"
        ? "PDF"
        : kind === "video"
          ? "Video"
          : kind === "audio"
            ? "Audio"
            : t().kindFile;
  };
  const close = (
    <IconButton size="sm" variant="ghost" label={t().close} onClick={props.onClose}>
      <i class="ti ti-x" aria-hidden="true" />
    </IconButton>
  );
  const expand = (item: FileEntry) => props.onPreview(item, () => setNotPdf(revision(item)));
  const actionRow = (
    title: string,
    icon: string,
    onClick: () => void,
    options: { danger?: boolean; description?: string; disabled?: boolean } = {},
  ) => (
    <DetailPanel.Action
      type="button"
      title={title}
      description={options.description}
      leading={<i class={`${icon} ${options.danger ? "text-danger" : ""}`} aria-hidden="true" />}
      class={options.danger ? "text-danger" : undefined}
      disabled={props.busy || options.disabled}
      onClick={onClick}
    />
  );
  return (
    <DetailPanel>
      <Show
        when={props.paths.length > 1}
        fallback={
          <Show
            when={entry()}
            fallback={
              <>
                <DetailPanel.Header title={t().details} actions={close} />
                <DetailPanel.Body>
                  <Placeholder
                    state={details.error() ? "error" : "loading"}
                    description={details.error() ? t().detailsFailed : t().loadingDetails}
                    action={details.error() ? <Button onClick={() => details.refresh()}>{t().retry}</Button> : undefined}
                  />
                </DetailPanel.Body>
              </>
            }
          >
            {(item) => (
              <>
                <DetailPanel.Header
                  icon={fileIcon(item())}
                  title={<span class="break-all">{item().name}</span>}
                  subtitle={
                    <span>
                      {kindLabel(item())}
                      <Show when={!item().directory}>
                        {" · "}
                        <Format.Bytes value={item().size} />
                      </Show>
                      {" · "}
                      <Format.DateTime value={item().modified} />
                    </span>
                  }
                  meta={
                    <Tooltip.Anchor content={copyLabel()}>
                      <IconButton size="xs" variant="ghost" label={copyLabel()} onClick={() => copyReference(item())}>
                        <i
                          class={
                            refClipboard.error()
                              ? "ti ti-alert-circle text-danger"
                              : refClipboard.wasCopied()
                                ? "ti ti-check"
                                : "ti ti-copy"
                          }
                          aria-hidden="true"
                        />
                      </IconButton>
                    </Tooltip.Anchor>
                  }
                  actions={close}
                  primaryActions={
                    <>
                      <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onOpen(item())}>
                        <i
                          class={item().directory ? "ti ti-folder-open" : props.editable?.(item()) ? "ti ti-pencil" : "ti ti-eye"}
                          aria-hidden="true"
                        />
                        {item().directory
                          ? t().open
                          : props.editable?.(item())
                            ? props.canEdit === false || item().actions?.write === false
                              ? t().openReadOnly
                              : t().edit
                            : t().preview}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onDownload([item()])}>
                        <i class="ti ti-download" aria-hidden="true" />
                        {f().download}
                      </Button>
                      <Tooltip.Anchor content={favorite(item()) ? t().removeFavorite : t().addFavorite}>
                        <IconButton
                          size="sm"
                          variant="secondary"
                          class="filesv2-favorite"
                          data-favorite={favorite(item()) ? "true" : undefined}
                          label={favorite(item()) ? t().removeFavorite : t().addFavorite}
                          aria-pressed={favorite(item())}
                          disabled={props.busy || !!favoritePending()}
                          onClick={() => void toggleFavorite(item(), !favorite(item()))}
                        >
                          <i class="ti ti-star filesv2-favorite__star" aria-hidden="true" />
                          <Show when={favorite(item())}>
                            <i class="ti ti-x filesv2-favorite__remove" aria-hidden="true" />
                          </Show>
                        </IconButton>
                      </Tooltip.Anchor>
                    </>
                  }
                />
                <DetailPanel.Body scrollPreserveKey={`filesv2-inspector:${props.base.id}:${item().path}`}>
                  <Show when={!item().directory && previewKind(item())}>
                    <DetailPanel.Group label={t().preview}>
                      <DetailPanel.Section
                        title={t().preview}
                        icon="ti ti-eye"
                        tone="neutral"
                        actions={
                          <IconButton size="sm" variant="ghost" label={t().expand} onClick={() => expand(item())}>
                            <i class="ti ti-arrows-maximize" aria-hidden="true" />
                          </IconButton>
                        }
                      >
                        <Show
                          keyed
                          when={
                            previewKind(item()) === "image"
                              ? JSON.stringify([props.base.id, props.base.locationKey, item().path, item().modified])
                              : null
                          }
                          fallback={
                            <Show keyed when={revision(item())}>
                              {(key) => (
                                <FilePreview
                                  variant="plain"
                                  previewLines={5}
                                  onExpandPreview={() => void expand(item())}
                                  baseId={props.base.id}
                                  locationKey={props.base.locationKey}
                                  entry={item()}
                                  onDownload={() => props.onDownload([item()])}
                                  onNotPdf={() => setNotPdf(key)}
                                />
                              )}
                            </Show>
                          }
                        >
                          <button type="button" class="filesv2-hero" onClick={() => expand(item())} aria-label={t().expand}>
                            <FileThumbnail baseId={props.base.id} locationKey={props.base.locationKey} entry={item()} large hero />
                          </button>
                        </Show>
                      </DetailPanel.Section>
                    </DetailPanel.Group>
                  </Show>
                  <DetailPanel.Summary title={t().info}>
                    <DescriptionList
                      layout="rows"
                      size="sm"
                      items={[
                        {
                          term: t().location,
                          description: (
                            <span class="break-all" title={`${props.base.name} / ${item().path}`}>
                              {`${baseLabel(props.base, t(), locale())} / ${item().path}`}
                            </span>
                          ),
                        },
                        { term: t().kind, description: kindLabel(item()) },
                        { term: f().modified, description: <Format.DateTime value={item().modified} /> },
                        ...(!item().directory ? [{ term: f().size, description: <Format.Bytes value={item().size} /> }] : []),
                        { term: t().storageArea, description: props.base.area === "cloud" ? t().cloudArea : t().freeipaArea },
                      ]}
                    />
                  </DetailPanel.Summary>
                  <DetailPanel.Group label={t().actions}>
                    <DetailPanel.Section title={t().actions} icon="ti ti-bolt" tone="neutral">
                      <div class="flex flex-col gap-1">
                        <Show when={!item().directory && notPdf() !== revision(item())}>
                          {actionRow(t().openInTab, "ti ti-external-link", () => void openInTab(item()))}
                        </Show>
                        {actionRow(t().rename, "ti ti-pencil", () => props.onRename(item()), { disabled: item().actions?.move === false })}
                        {actionRow(t().duplicate, "ti ti-copy", () => props.onDuplicate(item()))}
                        {actionRow(t().moveTo, "ti ti-arrow-move-right", () => props.onMove(item()), {
                          disabled: item().actions?.move === false,
                        })}
                        {actionRow(t().copyTo, "ti ti-folder-symlink", () => props.onCopy(item()))}
                        <Show when={props.onShare && item().actions?.share !== false}>
                          {actionRow(t().shareSelection, "ti ti-world-share", () => props.onShare?.(item()))}
                        </Show>
                        <Show when={props.onShareInbox && item().directory && item().actions?.write !== false}>
                          {actionRow(t().shareInbox, "ti ti-inbox", () => props.onShareInbox?.(item()))}
                        </Show>
                        {actionRow(t().trashSelection, "ti ti-trash", () => props.onTrash(item()), {
                          danger: true,
                          disabled: item().actions?.move === false,
                        })}
                      </div>
                    </DetailPanel.Section>
                  </DetailPanel.Group>
                  <EntryHistory
                    base={props.base}
                    entry={item()}
                    resourceId={details.data()?.result.resourceId}
                    busy={props.busy}
                    onChanged={props.onChanged}
                    locale={locale()}
                    history={props.history}
                  />
                </DetailPanel.Body>
              </>
            )}
          </Show>
        }
      >
        <DetailPanel.Header icon="ti ti-stack" title={t().selected(props.paths.length)} actions={close} />
        <DetailPanel.Body>
          <DetailPanel.Summary title={t().selection}>
            <DescriptionList
              layout="rows"
              size="sm"
              items={[
                { term: t().files, description: props.selected.filter((entry) => !entry.directory).length },
                { term: t().folders, description: props.selected.filter((entry) => entry.directory).length },
                {
                  term: t().knownBytes,
                  description: (
                    <Format.Bytes value={props.selected.filter((entry) => !entry.directory).reduce((sum, entry) => sum + entry.size, 0)} />
                  ),
                },
              ]}
            />
            <Show when={props.selected.some((entry) => entry.directory)}>
              <p class="text-sm text-dimmed">{t().unknownFolders}</p>
            </Show>
          </DetailPanel.Summary>
          <DetailPanel.Section title={t().actions} icon="ti ti-bolt" tone="neutral">
            <div class="flex flex-col gap-1">{actionRow(t().downloadZip, "ti ti-download", () => props.onDownload(props.selected))}</div>
          </DetailPanel.Section>
        </DetailPanel.Body>
      </Show>
    </DetailPanel>
  );
}

/**
 * Order of the detail as approved: public links, versions of a file, then the item's history. Versions and history
 * share one version list, so history rows can name "Version 2" with the number the list shows.
 */
function EntryHistory(props: {
  base: BaseSummary;
  entry: FileEntry;
  resourceId?: string;
  busy?: boolean;
  onChanged: (selectPath?: string | null) => void;
  locale: string;
  history?: InspectorHistory;
}) {
  const h = useHistoryMessages();
  const t = useBrowserMessages();
  const [versions, setVersions] = createSignal<readonly FileVersion[]>([]);
  // Numbers count the versions the list holds, oldest first; the current content comes after them.
  const ordered = createMemo(() => [...versions()].sort((a, b) => a.created.localeCompare(b.created)));
  const versionNumbers = createMemo(() => new Map(ordered().map((version, index) => [version.id, index + 1])));
  /**
   * An entry names a version only by an exact version ID, or as the current content when its new revision is the
   * file's revision now. Then the newest retained version is what that change replaced and may be restored.
   * A revision is never taken for a version ID.
   */
  const producesCurrent = (entry: ActivityEntry) =>
    (entry.action === "file.overwrite" || entry.action === "file.edit") &&
    entry.state === "done" &&
    entry.after.visibility === "full" &&
    !!entry.after.revision &&
    entry.after.revision === props.entry.revision;
  const versionOf = (entry: ActivityEntry) => {
    const side = entry.after.visibility === "full" ? entry.after : entry.before.visibility === "full" ? entry.before : null;
    const number = side?.versionId ? versionNumbers().get(side.versionId) : undefined;
    if (number) return { current: number, restorable: null };
    if (!producesCurrent(entry)) return null;
    const previous = ordered().length;
    return { current: previous + 1, restorable: previous > 0 && props.entry.actions?.write !== false ? previous : null };
  };
  const restorePrevious = async (entry: ActivityEntry) => {
    const previous = ordered().at(-1);
    if (!previous || !producesCurrent(entry)) throw new Error(h().actionFailed);
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
            <ShareHistory
              env={history().env}
              shares={itemShares()}
              period={period()}
              load={(request, signal) => loadShareAccess(request, period(), signal, h().accessFailed)}
              onRevoke={revoke}
            />
            <Show when={shares.loading() || shares.error() || shares.hasMore()}>
              <div role="group" aria-label={h().publicLink}>
                <Show when={shares.loading() && itemShares().length === 0}>
                  <p role="status">{t().loadingDetails}</p>
                </Show>
                <Show when={shares.error()}>
                  <p class="filesv2-item-history__line" role="alert">
                    {h().accessFailed}
                  </p>
                </Show>
                <Show when={shares.hasMore() || shares.error()}>
                  <Button
                    size="xs"
                    variant="text"
                    loading={shares.loadingMore() || shares.loading()}
                    onClick={() => void (shares.hasMore() ? shares.loadMore() : shares.refresh())}
                  >
                    {shares.error() ? h().retry : t().moreShares}
                  </Button>
                </Show>
              </div>
            </Show>
          </>
        )}
      </Show>
      <Show when={!props.entry.directory}>
        <VersionsSection
          base={props.base}
          entry={props.entry}
          busy={props.busy}
          onChanged={props.onChanged}
          locale={props.locale}
          onVersions={setVersions}
          number={(version) => versionNumbers().get(version.id)}
        />
      </Show>
      <Show when={props.history}>
        {(history) => (
          <ItemHistory
            env={history().env}
            actions={{ ...history().actions, version: versionOf, onRestoreVersion: restorePrevious }}
            directory={props.entry.directory}
            source={source()}
            initial={
              history().initial?.source === itemHistorySource(request()) ? { source: source(), page: history().initial!.page } : null
            }
            load={(cursor, signal) => loadItemHistory(request(), cursor, signal, h().historyFailed)}
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
  locale: string;
  onVersions?: (versions: readonly FileVersion[]) => void;
  number?: (version: FileVersion) => number | undefined;
}) {
  const h = useHistoryMessages();
  const t = useBrowserMessages();
  const f = useFilesMessages();
  const [busy, setBusy] = createSignal(false);
  const versions = query.create({
    source: () => JSON.stringify([props.base.id, props.base.locationKey, props.entry.path, props.entry.modified]),
    enabled: () => props.base.versioningEnabled,
    load: async (key, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"].versions.$get(
        { param: { baseId: props.base.id }, query: { path: props.entry.path } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) return apiFailure(response, t().detailsFailed);
      return { key, items: (await response.json()) as FileVersion[] };
    },
  });
  const items = createMemo(() =>
    versions.data()?.key === JSON.stringify([props.base.id, props.base.locationKey, props.entry.path, props.entry.modified])
      ? (versions.data()?.items ?? [])
      : [],
  );
  createEffect(() => props.onVersions?.(items()));
  const run = async (work: () => Promise<void>) => {
    if (busy() || props.busy) return;
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
      await versions.refresh();
    });
  };
  const restore = (version: FileVersion) =>
    run(async () => {
      const response = await apiClient.bases[":baseId"].versions.restore.$post({
        param: param(),
        json: { path: path(), id: version.id, expectedRevision: props.entry.revision },
      });
      if (!response.ok) await apiFailure(response, f().unavailable);
      toast.success(t().versionRestored);
      props.onChanged(path());
    });
  const restoreAs = async (version: FileVersion) => {
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
  const when = (iso: string) => new Date(iso).toLocaleString(props.locale, { dateStyle: "medium", timeStyle: "short" });
  return (
    <DetailPanel.Group label={t().versions}>
      <DetailPanel.Section
        title={t().versions}
        icon="ti ti-versions"
        tone="neutral"
        count={props.base.versioningEnabled ? items().length : undefined}
      >
        <Show when={props.base.versioningEnabled} fallback={<p class="text-xs text-dimmed">{t().versionsUnavailable}</p>}>
          <Show
            when={!versions.loading() || items().length}
            fallback={<Placeholder state="loading" align="left" class="px-0 py-1" description={t().loadingDetails} />}
          >
            <Show when={items().length} fallback={<p class="text-xs text-dimmed">{t().noVersions}</p>}>
              <div class="flex flex-col gap-1">
                <For each={items()}>
                  {(version) => (
                    <DetailPanel.Action
                      type="button"
                      title={
                        props.number?.(version)
                          ? `${h().versionN.replace("{n}", String(props.number(version)))} · ${when(version.created)}`
                          : t().versionLabel(when(version.created))
                      }
                      description={version.comment ? `${version.comment}${version.author ? ` · ${version.author}` : ""}` : undefined}
                      leading={<i class="ti ti-history" aria-hidden="true" />}
                      trailing={<Format.Bytes value={version.size} />}
                      disabled={busy() || props.busy}
                      onClick={() => (props.entry.actions?.write === false ? void downloadVersion(version) : void comment(version))}
                      menuLabel={`${t().actions}: ${when(version.created)}`}
                      menuItems={[
                        {
                          disabled: props.entry.actions?.write === false,
                          label: t().commentVersion,
                          icon: "ti ti-message",
                          action: () => void comment(version),
                        },
                        { label: t().downloadVersion, icon: "ti ti-download", action: () => void downloadVersion(version) },
                        {
                          disabled: props.entry.actions?.write === false,
                          label: t().restoreVersion,
                          icon: "ti ti-arrow-back-up",
                          action: () => void restore(version),
                        },
                        { label: t().restoreVersionAs, icon: "ti ti-file-plus", action: () => void restoreAs(version) },
                      ]}
                    />
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </Show>
      </DetailPanel.Section>
    </DetailPanel.Group>
  );
}
