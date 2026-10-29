import { cloudIdMessages, useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { query } from "@k2b/stdlib/solid";
import {
  Avatar,
  Button,
  DescriptionList,
  DetailPanel,
  type DropdownItem,
  FileGrid,
  FileTypeIcon,
  Format,
  fileKindLabel,
  formatFileViewSize,
  IconButton,
  Placeholder,
  prompts,
  StatusBadge,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, createUniqueId, For, Match, onCleanup, Show, Switch, untrack } from "solid-js";
import type { ActivityEntry } from "../activity-contracts";
import { apiClient } from "../api/client";
import type { BaseSummary, EntryResult, FileEntry, FileVersion, SharePage, ShareView } from "../contracts";
import { ENTRY_TYPE, entryRefId } from "../resource-ref";
import { activityVersion } from "./activity-versions";
import type { InspectorHistory } from "./Browser";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import FilePreview from "./FilePreview";
import FileThumbnail from "./FileThumbnail";
import { apiFailure, contentLease, inlinePdfHref, previewKind } from "./file-preview";
import { formatWhen, type HistoryEnvironment } from "./history-actions";
import { loadItemHistory, loadItemShares, loadShareAccess, restoreVersion, revokeShare } from "./history-api";
import { useHistoryMessages } from "./history-messages";
import { itemHistoryRequest, itemHistorySource, sharePeriod } from "./history-requests";
import ItemHistory from "./ItemHistory";
import ShareHistory, { createShareAccess, type ShareAccessRequest } from "./ShareHistory";
import { useFilesMessages } from "./messages";

/** One entry in the shared details outline: header, preview, properties, versions or contents, then technical details; a summary for several. */
export default function FileInspector(props: {
  base: BaseSummary;
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
  const cloudId = useCloudIdCopy();
  const entryRef = (item: FileEntry) => {
    const id = item.resourceId ?? details.data()?.result.resourceId ?? entryRefId(props.base.id, item.path);
    return id ? { type: ENTRY_TYPE, id } : null;
  };
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
  const close = (
    <IconButton size="sm" variant="ghost" label={t().close} onClick={props.onClose}>
      <i class="ti ti-x" aria-hidden="true" />
    </IconButton>
  );
  const expand = (item: FileEntry) => props.onPreview(item, () => setNotPdf(revision(item)));
  const readOnly = (item: FileEntry) => item.actions?.write === false;
  const metaLine = (item: FileEntry) =>
    item.directory ? t().kindFolder : `${fileKindLabel({ name: item.name }, locale())} · ${formatFileViewSize(item.size, locale())}`;
  // Rarer commands on the entry; Share and Download stay beside the main action.
  const headerMenu = (item: FileEntry): DropdownItem[] => [
    {
      items: [
        ...(!item.directory && notPdf() !== revision(item)
          ? [{ label: t().openInTab, icon: "ti ti-external-link", disabled: props.busy, action: () => void openInTab(item) }]
          : []),
        {
          label: t().rename,
          icon: "ti ti-pencil",
          disabled: props.busy || item.actions?.move === false,
          action: () => props.onRename(item),
        },
        { label: t().duplicate, icon: "ti ti-copy", disabled: props.busy, action: () => props.onDuplicate(item) },
        {
          label: t().moveTo,
          icon: "ti ti-arrow-move-right",
          disabled: props.busy || item.actions?.move === false,
          action: () => props.onMove(item),
        },
        { label: t().copyTo, icon: "ti ti-folder-symlink", disabled: props.busy, action: () => props.onCopy(item) },
        ...(props.onShareInbox && item.directory && !readOnly(item)
          ? [{ label: t().shareInbox, icon: "ti ti-inbox", disabled: props.busy, action: () => props.onShareInbox?.(item) }]
          : []),
      ],
    },
    {
      items: [
        {
          label: t().trashSelection,
          icon: "ti ti-trash",
          variant: "danger",
          disabled: props.busy || item.actions?.move === false,
          action: () => props.onTrash(item),
        },
      ],
    },
  ];
  return (
    <DetailPanel class="filesv2-inspector">
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
              const versions = createVersions(
                () => props.base,
                item,
                () => details.refresh(),
              );
              const versionsId = createUniqueId();
              const [versionsOpen, setVersionsOpen] = createSignal(false);
              const versionsLabel = () =>
                versions.state() === "ready"
                  ? String((versions.items()?.length ?? 0) + 1)
                  : versions.state() === "error"
                    ? h().versionsFailed
                    : t().loadingDetails;
              const showVersions = () => {
                setVersionsOpen(true);
                requestAnimationFrame(() => document.getElementById(versionsId)?.scrollIntoView({ block: "nearest" }));
              };
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
              return (
                <>
                  <DetailPanel.Header
                    kind={
                      <>
                        <span>{item().directory ? t().kindFolder : t().kindFile}</span>
                        <Show when={readOnly(item())}>
                          <StatusBadge tone="neutral" icon="ti ti-lock" label={t().readOnly} />
                        </Show>
                      </>
                    }
                    title={<span class="break-all">{item().name}</span>}
                    subtitle={
                      <span>
                        {metaLine(item())}
                        {" · "}
                        <Format.DateTime value={item().modified} />
                      </span>
                    }
                    menu={[...headerMenu(item()), ...cloudId.section(entryRef(item()))]}
                    menuLabel={t().moreActions}
                    actions={close}
                    primaryActions={
                      <>
                        <Button
                          size="sm"
                          variant="subtle"
                          class="filesv2-details-main"
                          disabled={props.busy}
                          onClick={() => props.onOpen(item())}
                        >
                          <i
                            class={item().directory ? "ti ti-folder-open" : props.editable?.(item()) ? "ti ti-pencil" : "ti ti-eye"}
                            aria-hidden="true"
                          />
                          {item().directory
                            ? t().open
                            : props.editable?.(item())
                              ? props.canEdit === false || readOnly(item())
                                ? t().openReadOnly
                                : t().edit
                              : t().preview}
                        </Button>
                        <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onDownload([item()])}>
                          <i class="ti ti-download" aria-hidden="true" />
                          {f().download}
                        </Button>
                        <Show when={props.onShare && item().actions?.share !== false}>
                          <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onShare?.(item())}>
                            <i class="ti ti-share" aria-hidden="true" />
                            {t().share}
                          </Button>
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
                      </>
                    }
                  />
                  <DetailPanel.Body scrollPreserveKey={`filesv2-inspector:${props.base.id}:${item().path}`}>
                    <Show when={!item().directory && previewKind(item())}>
                      <DetailPanel.Section
                        title={t().preview}
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
                    </Show>
                    <DetailPanel.Section title={t().properties} class="filesv2-inspector-info">
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
                          { term: t().storageArea, description: props.base.area === "cloud" ? t().cloudArea : t().freeipaArea },
                          {
                            term: f().modified,
                            description: (
                              <>
                                <Show when={props.history?.env} fallback={<Format.DateTime value={item().modified} />}>
                                  {(env) => <time datetime={item().modified}>{formatWhen(item().modified, locale(), h(), env())}</time>}
                                </Show>
                                <Show when={currentAuthor()}>{(name) => <span>, {name()}</span>}</Show>
                              </>
                            ),
                          },
                          ...(!item().directory
                            ? [
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
                                          onClick={() => (versionsOpen() ? setVersionsOpen(false) : showVersions())}
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
                    </DetailPanel.Section>
                    <Show when={item().directory}>
                      <FolderContents
                        base={props.base}
                        folder={item()}
                        busy={props.busy}
                        onOpen={props.onOpen}
                        onDownload={(file) => props.onDownload([file])}
                      />
                    </Show>
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
                      onShowVersions={showVersions}
                    />
                    <DetailPanel.Group title={item().directory ? t().moreAboutFolder : t().moreAboutFile}>
                      <DetailPanel.Section title={t().technicalDetails} collapsible summary={t().technicalSummary}>
                        <DescriptionList
                          layout="rows"
                          size="sm"
                          items={[
                            {
                              term: t().kind,
                              description: item().directory ? t().kindFolder : fileKindLabel({ name: item().name }, locale()),
                            },
                            ...(!item().directory ? [{ term: f().size, description: <Format.Bytes value={item().size} /> }] : []),
                            {
                              term: f().modified,
                              description: (
                                <>
                                  <Show when={props.history?.env} fallback={<Format.DateTime value={item().modified} />}>
                                    {(env) => <time datetime={item().modified}>{formatWhen(item().modified, locale(), h(), env())}</time>}
                                  </Show>
                                  <Show when={currentAuthor()}>{(name) => <span>, {name()}</span>}</Show>
                                </>
                              ),
                            },
                          ]}
                        />
                        <Show when={cloudId.available() && entryRef(item())}>
                          {(ref) => (
                            <DetailPanel.Action
                              type="button"
                              leading={<i class="ti ti-copy" aria-hidden="true" />}
                              title={cloudIdMessages.resolve([locale()]).t.copy}
                              onClick={() => cloudId.copy(ref())}
                            />
                          )}
                        </Show>
                      </DetailPanel.Section>
                    </DetailPanel.Group>
                  </DetailPanel.Body>
                </>
              );
            }}
          </Show>
        }
      >
        <DetailPanel.Header
          kind={<span>{t().selection}</span>}
          title={t().selected(props.paths.length)}
          actions={close}
          primaryActions={
            <Button
              size="sm"
              variant="subtle"
              class="filesv2-details-main"
              disabled={props.busy}
              onClick={() => props.onDownload(props.selected)}
            >
              <i class="ti ti-download" aria-hidden="true" />
              {t().downloadZip}
            </Button>
          }
        />
        <DetailPanel.Body>
          <DetailPanel.Section title={t().properties}>
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
              <p class="filesv2-details-none">{t().unknownFolders}</p>
            </Show>
          </DetailPanel.Section>
        </DetailPanel.Body>
      </Show>
    </DetailPanel>
  );
}

const isImage = (entry: FileEntry) => previewKind(entry) === "image";

/** The first page of a folder: files and subfolders as rows, then images as tiles; the folder itself shows the rest. */
function FolderContents(props: {
  base: BaseSummary;
  folder: FileEntry;
  busy?: boolean;
  onOpen: (entry: FileEntry) => void;
  onDownload: (entry: FileEntry) => void;
}) {
  const t = useBrowserMessages();
  const locale = useLocale();
  const key = () => JSON.stringify([props.base.id, props.base.locationKey, props.folder.path, props.folder.modified]);
  const contents = query.create({
    source: key,
    load: async (source, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"].entries.$get(
        { param: { baseId: props.base.id }, query: { path: props.folder.path } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) return apiFailure(response, t().contentsFailed);
      const page = await response.json();
      return { key: source, items: page.items, next: page.next };
    },
  });
  const page = () => (contents.data()?.key === key() ? contents.data() : undefined);
  // Short and full list keep one order: files and folders first, then images.
  const rows = createMemo(() => {
    const items = page()?.items ?? [];
    return [...items.filter((entry) => !isImage(entry)), ...items.filter(isImage)];
  });
  const meta = (entry: FileEntry) =>
    entry.directory ? t().kindFolder : `${fileKindLabel({ name: entry.name }, locale())} · ${formatFileViewSize(entry.size, locale())}`;
  return (
    <DetailPanel.Section title={t().contents} count={page() && !page()?.next && rows().length > 0 ? rows().length : undefined}>
      <Show
        when={!contents.error()}
        fallback={
          <Placeholder state="error" variant="compact" align="left" title={t().contentsFailed} onRetry={() => void contents.refresh()} />
        }
      >
        <Show when={page()} fallback={<Placeholder state="loading" align="left" class="px-0 py-1" description={t().loadingDetails} />}>
          <Show when={rows().length > 0} fallback={<p class="filesv2-details-none">{t().emptyTitle}</p>}>
            <FileGrid
              rows={rows()}
              getRowId={(entry) => entry.path}
              label={t().contents}
              layout="list"
              limit={5}
              actionVisibility="progressive"
              moreMeta={page()?.next ? t().moreInFolder : undefined}
              groups={(all) => [
                { id: "files", label: t().files, rows: all.filter((entry) => !isImage(entry)) },
                { id: "images", label: t().filterImages, rows: all.filter(isImage), layout: "tiles" },
              ]}
              renderPreview={(entry) =>
                isImage(entry) ? (
                  <FileThumbnail baseId={props.base.id} locationKey={props.base.locationKey} entry={entry} large />
                ) : (
                  <FileTypeIcon name={entry.name} folder={entry.directory} />
                )
              }
              renderLabel={(entry) => entry.name}
              renderMeta={meta}
              renderActions={(entry) => (
                <Show when={!entry.directory}>
                  <Tooltip.Anchor content={t().downloadNamed(entry.name)}>
                    <IconButton
                      size="sm"
                      variant="ghost"
                      label={t().downloadNamed(entry.name)}
                      disabled={props.busy}
                      onClick={() => props.onDownload(entry)}
                    >
                      <i class="ti ti-download" aria-hidden="true" />
                    </IconButton>
                  </Tooltip.Anchor>
                </Show>
              )}
              onOpen={props.onOpen}
            />
          </Show>
        </Show>
      </Show>
    </DetailPanel.Section>
  );
}

/**
 * The saved versions of a file, read once for the Properties count and the versions list. A second read of the file after
 * the list confirms that the list belongs to the shown file state; on a mismatch the details refresh first.
 */
function createVersions(base: () => BaseSummary, entry: () => FileEntry, onStale: () => Promise<void>) {
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
      <DetailPanel.Section
        title={t().versions}
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
      </DetailPanel.Section>
    </DetailPanel.Group>
  );
}
