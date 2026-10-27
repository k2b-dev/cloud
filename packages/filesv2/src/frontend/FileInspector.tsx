import { cloudResourceClipboard } from "@k2b/cloud/browser/resource-clipboard";
import { clipboard, query } from "@k2b/stdlib/solid";
import {
  Button,
  DescriptionList,
  DetailPanel,
  Dropdown,
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
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, EntryResult, FileEntry, FileVersion } from "../contracts";
import { ENTRY_TYPE, entryRefId } from "../resource-ref";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import FilePreview from "./FilePreview";
import FileThumbnail from "./FileThumbnail";
import { apiFailure, contentLease, inlinePdfHref, previewKind } from "./file-preview";
import { useFilesMessages } from "./messages";
import { referenceHref } from "./urls";

/** One entry in the shared details outline: header, preview, properties, versions or contents, then technical details; a summary for several. */
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
                      <Dropdown.Root items={headerMenu(item())} align="end" label={t().moreActions}>
                        <Dropdown.Trigger iconOnly size="sm" variant="ghost" label={t().moreActions}>
                          <i class="ti ti-dots" aria-hidden="true" />
                        </Dropdown.Trigger>
                      </Dropdown.Root>
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
                  <DetailPanel.Section title={t().properties}>
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
                      ]}
                    />
                  </DetailPanel.Section>
                  <Show
                    when={item().directory}
                    fallback={
                      <VersionsSection base={props.base} entry={item()} busy={props.busy} onChanged={props.onChanged} locale={locale()} />
                    }
                  >
                    <FolderContents
                      base={props.base}
                      folder={item()}
                      busy={props.busy}
                      onOpen={props.onOpen}
                      onDownload={(file) => props.onDownload([file])}
                    />
                  </Show>
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
                          { term: f().modified, description: <Format.DateTime value={item().modified} /> },
                        ]}
                      />
                      <DetailPanel.Action
                        type="button"
                        title={copyLabel()}
                        leading={
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
                        }
                        onClick={() => copyReference(item())}
                      />
                    </DetailPanel.Section>
                  </DetailPanel.Group>
                </DetailPanel.Body>
              </>
            )}
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

function VersionsSection(props: {
  base: BaseSummary;
  entry: FileEntry;
  busy?: boolean;
  onChanged: (selectPath?: string | null) => void;
  locale: string;
}) {
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
      const response = await apiClient.bases[":baseId"].versions.restore.$post({ param: param(), json: { path: path(), id: version.id } });
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
    <DetailPanel.Section title={t().versions} count={props.base.versioningEnabled && items().length > 0 ? items().length : undefined}>
      <Show when={props.base.versioningEnabled} fallback={<p class="filesv2-details-none">{t().versionsUnavailable}</p>}>
        <Show
          when={!versions.error()}
          fallback={
            <Placeholder state="error" variant="compact" align="left" title={t().versionsFailed} onRetry={() => void versions.refresh()} />
          }
        >
          <Show
            when={!versions.loading() || items().length}
            fallback={<Placeholder state="loading" align="left" class="px-0 py-1" description={t().loadingDetails} />}
          >
            <Show when={items().length} fallback={<p class="filesv2-details-none">{t().noVersions}</p>}>
              <div class="flex flex-col">
                <For each={items()}>
                  {(version) => (
                    <DetailPanel.Action
                      type="button"
                      title={t().versionLabel(when(version.created))}
                      description={[version.comment, version.author, formatFileViewSize(version.size, props.locale)]
                        .filter(Boolean)
                        .join(" · ")}
                      leading={<i class="ti ti-history" aria-hidden="true" />}
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
      </Show>
    </DetailPanel.Section>
  );
}
