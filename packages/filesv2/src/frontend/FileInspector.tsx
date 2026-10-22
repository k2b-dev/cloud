import { cloudResourceClipboard } from "@k2b/cloud/browser/resource-clipboard";
import { clipboard, query } from "@k2b/stdlib/solid";
import {
  Avatar,
  Button,
  DescriptionList,
  DetailPanel,
  Dropdown,
  type DropdownItem,
  Format,
  IconButton,
  Placeholder,
  prompts,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, createUniqueId, For, Match, onCleanup, Show, Switch } from "solid-js";
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
import { formatWhen, type HistoryEnvironment } from "./history-actions";
import { loadItemHistory, loadItemShares, loadShareAccess, restoreVersion, revokeShare } from "./history-api";
import { useHistoryMessages } from "./history-messages";
import { itemHistoryRequest, itemHistorySource, sharePeriod } from "./history-requests";
import ItemHistory from "./ItemHistory";
import { useFilesMessages } from "./messages";
import ShareHistory, { createShareAccess, type ShareAccessRequest } from "./ShareHistory";
import { referenceHref } from "./urls";

/**
 * Identity, a compact preview, one action bar, facts, versions and history of one entry; a summary for several.
 * The bar keeps the open action, download, share and favorite in view; every other action sits in its menu.
 * Phones show the approved short form: no preview, Info only with the change date and the version count, which opens
 * the versions in place, and no Info for a folder.
 */
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
  const h = useHistoryMessages();
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
  // The menu closes on copy, so a toast confirms the result the label shows while it stays open.
  const copyReference = (item: FileEntry) => {
    const id = item.resourceId ?? details.data()?.result.resourceId ?? entryRefId(props.base.id, item.path);
    if (!id) return;
    const href = referenceHref(props.base.id, item, id);
    void refClipboard
      .copy({ cloudUrl: props.cloudUrl, ref: { type: ENTRY_TYPE, id }, fallbackText: new URL(href, props.cloudUrl).href })
      .then((copied) => (copied ? toast.success(t().copiedReference) : toast.error(t().copyReferenceFailed)));
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
  /** The container of an entry, as the approved detail names it: storage, then each folder above the entry. */
  const place = (item: FileEntry) =>
    [baseLabel(props.base, t(), locale()), ...item.path.split("/").filter(Boolean).slice(0, -1)].join(" › ");
  /** Everything beyond the bar, with the same permissions and busy state the actions always had. */
  const menuItems = (item: FileEntry): DropdownItem[] => {
    const busy = !!props.busy;
    const editor = !item.directory && !!props.editable?.(item) && !!previewKind(item);
    return [
      ...(!item.directory && notPdf() !== revision(item)
        ? [{ disabled: busy, label: t().openInTab, icon: "ti ti-external-link", action: () => void openInTab(item) }]
        : []),
      // The bar's main action edits such a file; the large preview stays one step away.
      ...(editor ? [{ disabled: busy, label: t().expand, icon: "ti ti-arrows-maximize", action: () => expand(item) }] : []),
      { disabled: busy || item.actions?.move === false, label: t().rename, icon: "ti ti-pencil", action: () => props.onRename(item) },
      { disabled: busy, label: t().duplicate, icon: "ti ti-copy", action: () => props.onDuplicate(item) },
      {
        disabled: busy || item.actions?.move === false,
        label: t().moveTo,
        icon: "ti ti-arrow-move-right",
        action: () => props.onMove(item),
      },
      { disabled: busy, label: t().copyTo, icon: "ti ti-folder-symlink", action: () => props.onCopy(item) },
      ...(props.onShareInbox && item.directory && item.actions?.write !== false
        ? [{ disabled: busy, label: t().shareInbox, icon: "ti ti-inbox", action: () => props.onShareInbox?.(item) }]
        : []),
      {
        label: copyLabel(),
        icon: refClipboard.error() ? "ti ti-alert-circle" : refClipboard.wasCopied() ? "ti ti-check" : "ti ti-link",
        immediate: true,
        action: () => copyReference(item),
      },
      {
        items: [
          {
            disabled: busy || item.actions?.move === false,
            label: t().trashSelection,
            icon: "ti ti-trash",
            variant: "danger" as const,
            action: () => props.onTrash(item),
          },
        ],
      },
    ];
  };
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
            {(item) => {
              // One versions request feeds the Info count on phones and the versions list.
              const versions = createVersions(() => props.base, item);
              const currentAuthor = () => {
                const history = props.history?.initial;
                const request = itemHistoryRequest(props.base, {
                  ...item(),
                  resourceId: item().resourceId ?? details.data()?.result.resourceId,
                });
                if (!item().revision || history?.source !== itemHistorySource(request)) return null;
                const change = history.page.items.find(
                  (change) =>
                    change.state === "done" &&
                    ["file.create", "file.upload", "file.overwrite", "file.edit", "version.restore"].includes(change.action) &&
                    change.after.visibility === "full" &&
                    change.after.revision === item().revision,
                );
                return change?.actor.kind === "user" ? change.actor.name : null;
              };
              const versionsId = createUniqueId();
              const [versionsOpen, setVersionsOpen] = createSignal(false);
              const versionsLabel = () =>
                versions.state() === "ready"
                  ? String((versions.items()?.length ?? 0) + 1)
                  : versions.state() === "error"
                    ? h().versionsFailed
                    : t().loadingDetails;
              const toggleVersions = () => {
                const open = !versionsOpen();
                setVersionsOpen(open);
                if (open) requestAnimationFrame(() => document.getElementById(versionsId)?.scrollIntoView({ block: "nearest" }));
              };
              return (
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
                      </span>
                    }
                    actions={close}
                  />
                  <DetailPanel.Body scrollPreserveKey={`filesv2-inspector:${props.base.id}:${item().path}`}>
                    <div class="filesv2-inspector-lead">
                      {/* A compact glimpse; the bar's Preview, a click on an image, or the menu opens it large. */}
                      <Show when={!item().directory && previewKind(item())}>
                        <div class="filesv2-inspector-preview" role="group" aria-label={t().preview}>
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
                        </div>
                      </Show>
                      <div class="filesv2-inspector-actions">
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
                        <Tooltip.Anchor content={f().download}>
                          <IconButton
                            size="sm"
                            variant="ghost"
                            label={f().download}
                            disabled={props.busy}
                            onClick={() => props.onDownload([item()])}
                          >
                            <i class="ti ti-download" aria-hidden="true" />
                          </IconButton>
                        </Tooltip.Anchor>
                        <Show when={props.onShare && item().actions?.share !== false}>
                          <Tooltip.Anchor content={t().shareSelection}>
                            <IconButton
                              size="sm"
                              variant="ghost"
                              label={t().shareSelection}
                              disabled={props.busy}
                              onClick={() => props.onShare?.(item())}
                            >
                              <i class="ti ti-share" aria-hidden="true" />
                            </IconButton>
                          </Tooltip.Anchor>
                        </Show>
                        <Tooltip.Anchor content={favorite(item()) ? t().removeFavorite : t().addFavorite}>
                          <IconButton
                            size="sm"
                            variant="ghost"
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
                        <Dropdown.Root items={menuItems(item())} label={t().actions} menuClass="filesv2-inspector-menu" phone="sheet">
                          <Dropdown.Trigger iconOnly size="sm" label={t().actions}>
                            <i class="ti ti-dots" aria-hidden="true" />
                          </Dropdown.Trigger>
                        </Dropdown.Root>
                      </div>
                    </div>
                    <DetailPanel.Summary
                      title={t().info}
                      class={item().directory ? "filesv2-inspector-info filesv2-inspector-info--folder" : "filesv2-inspector-info"}
                    >
                      {/* Rows marked for one form only; phones keep the change date and the version count. */}
                      <DescriptionList
                        layout="rows"
                        size="sm"
                        items={[
                          {
                            term: t().location,
                            description: (
                              <span class="break-words" data-inspector-only="desktop" title={`${props.base.name} / ${item().path}`}>
                                {place(item())}
                              </span>
                            ),
                          },
                          {
                            term: f().modified,
                            description: (
                              <>
                                <Format.DateTime value={item().modified} />
                                <Show when={currentAuthor()}>{(name) => <span>, {name()}</span>}</Show>
                              </>
                            ),
                          },
                          ...(!item().directory
                            ? [
                                {
                                  term: f().size,
                                  description: (
                                    <span data-inspector-only="desktop">
                                      <Format.Bytes value={item().size} />
                                    </span>
                                  ),
                                },
                                {
                                  term: t().versions,
                                  description: (
                                    <span data-inspector-only="phone">
                                      <Show when={versions.state() !== "off"} fallback={t().versionsUnavailable}>
                                        <Button
                                          size="xs"
                                          variant="text"
                                          aria-label={`${h().showVersions} (${versionsLabel()})`}
                                          aria-expanded={versionsOpen()}
                                          aria-controls={versionsId}
                                          onClick={toggleVersions}
                                        >
                                          {versionsLabel()}
                                        </Button>
                                      </Show>
                                    </span>
                                  ),
                                },
                              ]
                            : []),
                        ]}
                      />
                    </DetailPanel.Summary>
                    <EntryHistory
                      base={props.base}
                      entry={item()}
                      resourceId={details.data()?.result.resourceId}
                      busy={props.busy}
                      onChanged={props.onChanged}
                      onOpen={props.onOpen}
                      locale={locale()}
                      history={props.history}
                      versions={versions}
                      currentAuthor={currentAuthor()}
                      versionsId={versionsId}
                      versionsOpen={versionsOpen()}
                      onShowVersions={() => {
                        setVersionsOpen(true);
                        requestAnimationFrame(() => document.getElementById(versionsId)?.scrollIntoView({ block: "nearest" }));
                      }}
                    />
                  </DetailPanel.Body>
                </>
              );
            }}
          </Show>
        }
      >
        <DetailPanel.Header
          icon="ti ti-stack"
          title={t().selected(props.paths.length)}
          actions={close}
          primaryActions={
            <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onDownload(props.selected)}>
              <i class="ti ti-download" aria-hidden="true" />
              {t().downloadZip}
            </Button>
          }
        />
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
        </DetailPanel.Body>
      </Show>
    </DetailPanel>
  );
}

/** The saved versions of a file, read once for the Info count and the versions list. */
function createVersions(base: () => BaseSummary, entry: () => FileEntry) {
  const t = useBrowserMessages();
  const key = () => JSON.stringify([base().id, base().locationKey, entry().path, entry().modified]);
  const versions = query.create({
    source: key,
    enabled: () => base().versioningEnabled && !entry().directory,
    load: async (key, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"].versions.$get(
        { param: { baseId: base().id }, query: { path: entry().path } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) return apiFailure(response, t().detailsFailed);
      return { key, items: (await response.json()) as FileVersion[] };
    },
  });
  /** `null` until the list of this exact file state arrived; then never an empty stand-in for "unknown". */
  const items = createMemo(() => (versions.data()?.key === key() ? (versions.data()?.items ?? null) : null));
  const state = () => (!base().versioningEnabled ? "off" : versions.error() ? "error" : items() ? "ready" : "loading");
  return { items, state, refresh: () => versions.refresh() };
}
type Versions = ReturnType<typeof createVersions>;

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
    if (props.versions.state() !== "ready") return null;
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
  const loadAccess = (request: ShareAccessRequest, signal: AbortSignal) => loadShareAccess(request, period(), signal, h().accessFailed);
  // One access query per loaded link feeds both its facts and the item's history.
  const links = createShareAccess({ shares: itemShares, period, load: loadAccess });
  const linksState = () =>
    shares.pages().length === 0 && !shares.error() ? "loading" : shares.hasMore() || shares.error() ? "partial" : "complete";
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
  // Newest first, below the current file, as the approved list reads.
  const listed = createMemo(() => [...items()].sort((a, b) => b.created.localeCompare(a.created)));
  const run = async (work: () => Promise<void>) => {
    if (busy() || props.busy || props.versions.state() !== "ready") return;
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
    if (props.versions.state() !== "ready") return;
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
      const response = await apiClient.bases[":baseId"].versions.restore.$post({
        param: param(),
        json: { path: path(), id: version.id, expectedRevision: props.entry.revision },
      });
      if (!response.ok) await apiFailure(response, f().unavailable);
      toast.success(t().versionRestored);
      props.onChanged(path());
    });
  const restoreAs = async (version: FileVersion) => {
    if (props.versions.state() !== "ready") return;
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
      <DetailPanel.Section
        title={t().versions}
        icon="ti ti-versions"
        tone="neutral"
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
            <div class="flex flex-col gap-1">
              {/* The file as it is now, numbered after the saved versions as the history counts it. */}
              <DetailPanel.Action
                type="button"
                title={
                  props.versions.state() === "ready"
                    ? `${h().versionN.replace("{n}", String(items().length + 1))} · ${h().versionCurrent}`
                    : h().versionCurrent
                }
                leading={
                  <Avatar
                    name={props.currentAuthor ?? h().versionCurrent}
                    icon={props.currentAuthor ? undefined : "ti ti-file"}
                    size="xs"
                    style={{ width: "20px", height: "20px" }}
                  />
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
                    description={version.comment ? `${version.comment}${version.author ? ` · ${version.author}` : ""}` : undefined}
                    // Filegate's author metadata names the comment editor, not the content author.
                    leading={<Avatar name={t().versions} icon="ti ti-history" size="xs" style={{ width: "20px", height: "20px" }} />}
                    trailing={
                      <time dateTime={version.created} title={when(version.created)}>
                        {when(version.created)}
                      </time>
                    }
                    disabled={busy() || props.busy || props.versions.state() !== "ready"}
                    onClick={() => (props.entry.actions?.write === false ? void downloadVersion(version) : void comment(version))}
                    menuLabel={`${t().actions}: ${when(version.created)}`}
                    menuItems={[
                      {
                        disabled: props.versions.state() !== "ready" || props.entry.actions?.write === false,
                        label: t().commentVersion,
                        icon: "ti ti-message",
                        action: () => void comment(version),
                      },
                      {
                        disabled: props.versions.state() !== "ready",
                        label: t().downloadVersion,
                        icon: "ti ti-download",
                        action: () => void downloadVersion(version),
                      },
                      {
                        disabled: props.versions.state() !== "ready" || props.entry.actions?.write === false,
                        label: t().restoreVersion,
                        icon: "ti ti-arrow-back-up",
                        action: () => void restore(version),
                      },
                      {
                        disabled: props.versions.state() !== "ready",
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
      </DetailPanel.Section>
    </DetailPanel.Group>
  );
}
