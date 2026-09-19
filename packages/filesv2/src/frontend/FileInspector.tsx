import { cloudResourceClipboard } from "@k2b/cloud/browser/resource-clipboard";
import { clipboard, query } from "@k2b/stdlib/solid";
import { Button, DescriptionList, DetailPanel, Format, IconButton, Placeholder, prompts, toast, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, EntryResult, FileEntry, FileVersion } from "../contracts";
import { ENTRY_TYPE, entryRefId } from "../resource-ref";
import { useBrowserMessages } from "./browser-messages";
import FilePreview from "./FilePreview";
import FileThumbnail from "./FileThumbnail";
import { apiFailure, contentLease, fileIcon, previewKind } from "./file-preview";
import { documentPreviewable } from "./FileThumbnail";
import { useFilesMessages } from "./messages";
import { filesUrl } from "./urls";

/** Identity, quick preview, facts, actions and versions of one entry; a summary for several. */
export default function FileInspector(props: {
  base: BaseSummary;
  cloudUrl: string;
  selected: readonly FileEntry[];
  paths: readonly string[];
  initial?: EntryResult | null;
  busy?: boolean;
  onClose: () => void;
  onOpen: (entry: FileEntry) => void;
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
  /** Document previews are possible when the editor is configured. */
  documents?: boolean;
}) {
  const t = useBrowserMessages();
  const f = useFilesMessages();
  // The favorite flag comes with the entry; a toggle overrides it locally until the next load.
  const [favoriteOverride, setFavoriteOverride] = createSignal<{ path: string; favorite: boolean } | null>(null);
  const toggleFavorite = async (entry: FileEntry, favorite: boolean) => {
    try {
      const response = await apiClient.bases[":baseId"].favorite.$post({ param: { baseId: props.base.id }, json: { path: entry.path, favorite } });
      if (!response.ok) await apiFailure(response, f().unavailable);
      setFavoriteOverride({ path: entry.path, favorite: (await response.json()).favorite ?? favorite });
      toast.success(favorite ? t().favoriteAdded : t().favoriteRemoved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : f().unavailable);
    }
  };
  const locale = useLocale();
  const source = () => JSON.stringify([props.base.id, props.paths.length === 1 ? props.paths[0] : null, props.selected.find((entry) => entry.path === props.paths[0])?.modified]);
  const initial =
    props.initial && props.paths.length === 1 && props.initial.entry.path === props.paths[0]
      ? { source: source(), data: { key: source(), result: props.initial } }
      : undefined;
  const details = query.create({
    source,
    initial,
    enabled: () => props.paths.length === 1,
    load: async (key, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"].entry.$get({ param: { baseId: props.base.id }, query: { path: props.paths[0]! } }, { init: { signal: abortSignal } });
      if (!response.ok) return apiFailure(response, t().detailsFailed);
      return { key, result: await response.json() };
    },
  });
  const entry = () => (details.data()?.key === source() && !details.error() ? details.data()?.result.entry : null);
  const refClipboard = clipboard.createWriter({ write: cloudResourceClipboard.write, copiedFor: 1800 });
  const copyReference = (item: FileEntry) => {
    const id = entryRefId(props.base.id, item.path);
    if (!id) return;
    const href = item.directory ? filesUrl(props.base.id, item.path) : filesUrl(props.base.id, item.path.split("/").slice(0, -1).join("/"), null, item.path);
    void refClipboard.copy({ cloudUrl: props.cloudUrl, ref: { type: ENTRY_TYPE, id }, fallbackText: new URL(href, props.cloudUrl).href });
  };
  const copyLabel = () => (refClipboard.error() ? t().copyReferenceFailed : refClipboard.wasCopied() ? t().copiedReference : t().copyReference);
  const openInTab = async (item: FileEntry) => {
    const tab = window.open("", "_blank", "noopener");
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
    return kind === "image" ? t().kindImage : kind === "pdf" ? "PDF" : kind === "video" ? "Video" : kind === "audio" ? "Audio" : t().kindFile;
  };
  const close = (
    <IconButton size="sm" variant="ghost" label={t().close} onClick={props.onClose}>
      <i class="ti ti-x" aria-hidden="true" />
    </IconButton>
  );
  const expand = (item: FileEntry) =>
    prompts.dialog(() => <FilePreview baseId={props.base.id} entry={item} onDownload={() => props.onDownload([item])} />, { title: item.name, size: "large" });
  const actionRow = (title: string, icon: string, onClick: () => void, options: { danger?: boolean; description?: string } = {}) => (
    <DetailPanel.Action
      type="button"
      title={title}
      description={options.description}
      leading={<i class={`${icon} ${options.danger ? "text-danger" : ""}`} aria-hidden="true" />}
      class={options.danger ? "text-danger" : undefined}
      disabled={props.busy}
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
                        <i class={refClipboard.error() ? "ti ti-alert-circle text-danger" : refClipboard.wasCopied() ? "ti ti-check" : "ti ti-copy"} aria-hidden="true" />
                      </IconButton>
                    </Tooltip.Anchor>
                  }
                  actions={close}
                  primaryActions={
                    <>
                      <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onOpen(item())}>
                        <i class={item().directory ? "ti ti-folder-open" : props.editable?.(item()) ? "ti ti-pencil" : "ti ti-eye"} aria-hidden="true" />
                        {item().directory ? t().open : props.editable?.(item()) ? (props.canEdit === false ? t().openReadOnly : t().edit) : t().preview}
                      </Button>
                      <Button size="sm" variant="secondary" disabled={props.busy} onClick={() => props.onDownload([item()])}>
                        <i class="ti ti-download" aria-hidden="true" />
                        {f().download}
                      </Button>
                    </>
                  }
                />
                <DetailPanel.Body scrollPreserveKey={`filesv2-inspector:${props.base.id}:${item().path}`}>
                  <Show when={!item().directory && (previewKind(item()) || (props.documents && documentPreviewable(item())))}>
                    <DetailPanel.Group label={t().preview}>
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
                        when={previewKind(item()) === "image" || (props.documents && !previewKind(item()) && documentPreviewable(item())) ? `${props.base.id}:${item().path}:${item().modified}` : null}
                        fallback={
                          <Show keyed when={`${props.base.id}:${item().path}:${item().modified}`}>
                            <FilePreview baseId={props.base.id} entry={item()} onDownload={() => props.onDownload([item()])} />
                          </Show>
                        }
                      >
                        <button type="button" class="filesv2-hero" onClick={() => expand(item())} aria-label={t().expand}>
                          <FileThumbnail baseId={props.base.id} entry={item()} large hero documents={props.documents} />
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
                        { term: t().location, description: <span class="break-all">{`${props.base.name} / ${item().path}`}</span> },
                        { term: t().kind, description: kindLabel(item()) },
                        { term: f().modified, description: <Format.DateTime value={item().modified} /> },
                        ...(!item().directory ? [{ term: f().size, description: <Format.Bytes value={item().size} /> }] : []),
                        { term: t().storageArea, description: props.base.area === "cloud" ? t().cloudArea : t().freeipaArea },
                      ]}
                    />
                  </DetailPanel.Summary>
                  <DetailPanel.Group label={t().actions}>
                    <DetailPanel.Section title={t().actions}>
                      <div class="flex flex-col gap-1">
                        <Show when={!item().directory}>{actionRow(t().openInTab, "ti ti-external-link", () => void openInTab(item()))}</Show>
                        {(() => {
                          const favorite = () => (favoriteOverride()?.path === item().path ? favoriteOverride()!.favorite : (details.data()?.result.favorite ?? false));
                          return actionRow(favorite() ? t().removeFavorite : t().addFavorite, favorite() ? "ti ti-star-filled" : "ti ti-star", () => void toggleFavorite(item(), !favorite()));
                        })()}
                        {actionRow(t().rename, "ti ti-pencil", () => props.onRename(item()))}
                        {actionRow(t().duplicate, "ti ti-copy", () => props.onDuplicate(item()))}
                        {actionRow(t().moveTo, "ti ti-arrow-move-right", () => props.onMove(item()))}
                        {actionRow(t().copyTo, "ti ti-folder-symlink", () => props.onCopy(item()))}
                        <Show when={props.onShare}>{actionRow(t().shareSelection, "ti ti-world-share", () => props.onShare?.(item()))}</Show>
                        <Show when={props.onShareInbox && item().directory}>{actionRow(t().shareInbox, "ti ti-inbox", () => props.onShareInbox?.(item()))}</Show>
                        {actionRow(t().trashSelection, "ti ti-trash", () => props.onTrash(item()), { danger: true })}
                      </div>
                    </DetailPanel.Section>
                  </DetailPanel.Group>
                  <Show when={!item().directory}>
                    <VersionsSection base={props.base} entry={item()} busy={props.busy} onChanged={props.onChanged} locale={locale()} />
                  </Show>
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
                { term: t().knownBytes, description: <Format.Bytes value={props.selected.filter((entry) => !entry.directory).reduce((sum, entry) => sum + entry.size, 0)} /> },
              ]}
            />
            <Show when={props.selected.some((entry) => entry.directory)}>
              <p class="text-sm text-dimmed">{t().unknownFolders}</p>
            </Show>
          </DetailPanel.Summary>
          <DetailPanel.Section title={t().actions}>
            <div class="flex flex-col gap-1">
              {actionRow(t().downloadZip, "ti ti-download", () => props.onDownload(props.selected))}
            </div>
          </DetailPanel.Section>
        </DetailPanel.Body>
      </Show>
    </DetailPanel>
  );
}

function VersionsSection(props: { base: BaseSummary; entry: FileEntry; busy?: boolean; onChanged: (selectPath?: string | null) => void; locale: string }) {
  const t = useBrowserMessages();
  const f = useFilesMessages();
  const [busy, setBusy] = createSignal(false);
  const versions = query.create({
    source: () => JSON.stringify([props.base.id, props.entry.path, props.entry.modified]),
    enabled: () => props.base.versioningEnabled,
    load: async (key, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"].versions.$get({ param: { baseId: props.base.id }, query: { path: props.entry.path } }, { init: { signal: abortSignal } });
      if (!response.ok) return apiFailure(response, t().detailsFailed);
      return { key, items: (await response.json()) as FileVersion[] };
    },
  });
  const items = createMemo(() => versions.data()?.items ?? []);
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
  const param = { baseId: props.base.id };
  const path = () => props.entry.path;
  const comment = async (version: FileVersion) => {
    const values = await prompts.form({ title: t().commentVersion, fields: { comment: { type: "text", label: t().versionComment, default: version.comment ?? "", maxLength: 2000, multiline: true, lines: 3 } } });
    if (!values) return;
    await run(async () => {
      const response = await apiClient.bases[":baseId"].versions.comment.$post({ param, json: { path: path(), id: version.id, comment: String(values.comment ?? "") } });
      if (!response.ok) await apiFailure(response, f().unavailable);
      toast.success(t().versionCommented);
      await versions.refresh();
    });
  };
  const restore = (version: FileVersion) =>
    run(async () => {
      const response = await apiClient.bases[":baseId"].versions.restore.$post({ param, json: { path: path(), id: version.id } });
      if (!response.ok) await apiFailure(response, f().unavailable);
      toast.success(t().versionRestored);
      props.onChanged(path());
    });
  const restoreAs = async (version: FileVersion) => {
    const dot = props.entry.name.lastIndexOf(".");
    const suggested = dot > 0 ? `${props.entry.name.slice(0, dot)} (${t().versions.toLowerCase()})${props.entry.name.slice(dot)}` : `${props.entry.name} (${t().versions.toLowerCase()})`;
    const values = await prompts.form({ title: t().restoreVersionAs, fields: { name: { type: "text", label: t().restoreAsName, default: suggested, required: true, maxLength: 255 } } });
    if (!values) return;
    await run(async () => {
      const response = await apiClient.bases[":baseId"].versions["restore-as"].$post({ param, json: { path: path(), id: version.id, name: values.name } });
      if (!response.ok) await apiFailure(response, f().unavailable);
      toast.success(t().versionRestored);
      props.onChanged((await response.json()).entry.path);
    });
  };
  const remove = async (version: FileVersion) => {
    const confirmed = await prompts.confirm(t().deleteVersionQuestion, { title: t().deleteVersion, icon: "ti ti-trash", variant: "danger", confirmText: t().deleteVersion });
    if (!confirmed) return;
    await run(async () => {
      const response = await apiClient.bases[":baseId"].versions.delete.$post({ param, json: { path: path(), id: version.id } });
      if (!response.ok) await apiFailure(response, f().unavailable);
      toast.success(t().versionDeleted);
      await versions.refresh();
    });
  };
  const downloadVersion = (version: FileVersion) =>
    run(async () => {
      const response = await apiClient.bases[":baseId"].versions.download.$post({ param, json: { path: path(), id: version.id } });
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
      <DetailPanel.Section title={t().versions} icon="ti ti-history" tone="neutral" meta={props.base.versioningEnabled ? items().length : undefined}>
        <Show when={props.base.versioningEnabled} fallback={<p class="text-xs text-dimmed">{t().versionsUnavailable}</p>}>
          <Show when={!versions.loading() || items().length} fallback={<Placeholder state="loading" align="left" class="px-0 py-1" description={t().loadingDetails} />}>
            <Show when={items().length} fallback={<p class="text-xs text-dimmed">{t().noVersions}</p>}>
              <div class="flex flex-col gap-1">
                <For each={items()}>
                  {(version) => (
                    <DetailPanel.Action
                      type="button"
                      title={t().versionLabel(when(version.created))}
                      description={version.comment ? `${version.comment}${version.author ? ` · ${version.author}` : ""}` : undefined}
                      leading={<i class="ti ti-history" aria-hidden="true" />}
                      trailing={<Format.Bytes value={version.size} />}
                      disabled={busy() || props.busy}
                      onClick={() => void comment(version)}
                      menuLabel={`${t().actions}: ${when(version.created)}`}
                      menuItems={[
                        { label: t().commentVersion, icon: "ti ti-message", action: () => void comment(version) },
                        { label: t().downloadVersion, icon: "ti ti-download", action: () => void downloadVersion(version) },
                        { label: t().restoreVersion, icon: "ti ti-arrow-back-up", action: () => void restore(version) },
                        { label: t().restoreVersionAs, icon: "ti ti-file-plus", action: () => void restoreAs(version) },
                        { items: [{ label: t().deleteVersion, icon: "ti ti-trash", variant: "danger" as const, action: () => void remove(version) }] },
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
