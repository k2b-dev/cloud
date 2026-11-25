import { cloudIdMessages, useCloudIdCopy } from "@k2b/cloud/browser/cloud-id";
import { publishPageContext } from "@k2b/cloud/browser/panel";
import { query } from "@k2b/stdlib/solid";
import { fileKindLabel, formatFileViewSize, toast, useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Canvas,
  Chip,
  Facts,
  Failed,
  Inline,
  List,
  Loading,
  Menu,
  type MenuEntry,
  type OnNavigate,
  Pane,
  Row,
  Section,
  Text,
} from "@k2b/ui/v2";
import { createEffect, createMemo, onCleanup, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { BaseSummary, EntryResult, FileEntry } from "../contracts";
import { ENTRY_TYPE, entryRefId, FOLDER_TYPE } from "../resource-ref";
import { baseLabel } from "./base-label";
import { useBrowserMessages } from "./browser-messages";
import { createVersions, EntryHistory, type InspectorHistory } from "./entry-history";
import { entryIcon } from "./entry-icon";
import FilePreview from "./FilePreview";
import FileThumbnail from "./FileThumbnail";
import { apiFailure, contentLease, inlinePdfHref, previewKind } from "./file-preview";
import type { FolderActions } from "./folder-actions";
import { formatWhen } from "./history-actions";
import { useHistoryMessages } from "./history-messages";
import { itemHistoryRequest, itemHistorySource } from "./history-requests";
import { useFilesMessages } from "./messages";
import { previewRevision, previewSource } from "./preview-client";
import { filesUrl } from "./urls";

/** How many entries of a folder its detail lists; the folder itself shows the rest. */
const CONTENTS_SHOWN = 5;

export type EntryDetailProps = {
  base: BaseSummary;
  /** The entry the address names. */
  path: string;
  /** The entry as the listing knows it, so the head stands at once. */
  listed?: FileEntry;
  /** The server's read of this entry for the first picture. */
  initial?: EntryResult | null;
  history?: InspectorHistory;
  actions: FolderActions;
  /** The folder without the open entry: where closing and the way back lead. */
  closeHref: string;
  folderName: string;
  onNavigate: OnNavigate;
  onEdit: (entry: FileEntry) => void;
  onShare: (paths: readonly string[]) => void;
  onShareInbox: (folder: string) => void;
  onChanged: (selectPath?: string | null) => Promise<void>;
};

/** The open entry beside the folder: its deeds, preview, properties, contents of a folder, links, versions and history. */
export default function EntryDetail(props: EntryDetailProps) {
  const t = useBrowserMessages();
  const f = useFilesMessages();
  const locale = useLocale();
  const cloudId = useCloudIdCopy();
  const source = () => JSON.stringify([props.base.id, props.base.locationKey, props.path, props.listed?.modified]);
  const initial =
    props.initial && props.initial.base.id === props.base.id && props.initial.entry.path === props.path
      ? { source: source(), data: { key: source(), result: props.initial } }
      : undefined;
  const details = query.create({
    source,
    initial,
    load: async (key, { abortSignal }) => {
      const response = await apiClient.bases[":baseId"].entry.$get(
        { param: { baseId: props.base.id }, query: { path: props.path } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) return apiFailure(response, t().detailsFailed);
      return { key, result: await response.json() };
    },
  });
  const result = () => (details.data()?.key === source() && !details.error() ? details.data()?.result : undefined);
  const entry = () => result()?.entry;
  // The favorite as the server answered the last toggle, until the details read it again.
  const favorite = createMemo(() => result()?.favorite ?? false);
  const entryRef = (item: FileEntry) => {
    const id = item.resourceId ?? result()?.resourceId ?? entryRefId(props.base.id, item.path);
    return id ? { type: ENTRY_TYPE, id } : null;
  };
  createEffect(() => {
    const item = entry();
    if (!item) return;
    const ref = entryRef(item);
    if (ref) onCleanup(publishPageContext({ scope: { ...ref, type: item.directory ? FOLDER_TYPE : ENTRY_TYPE } }));
  });
  const head = () => entry() ?? props.listed;
  return (
    <Pane
      detail
      label={head()?.name ?? props.path.split("/").at(-1) ?? props.path}
      back={{ label: props.folderName, href: props.closeHref, onNavigate: props.onNavigate }}
      head={
        <Bar
          start={<Text type="lead">{head()?.name ?? props.path.split("/").at(-1)}</Text>}
          end={<Button variant="ghost" icon="x" label={t().close} href={props.closeHref} onNavigate={props.onNavigate} />}
        />
      }
    >
      <Show
        when={entry()}
        fallback={
          <Show when={details.error()} fallback={<Loading rows={4} lines={2} />}>
            <Failed text={t().detailsFailed} onRetry={() => void details.refresh()} />
          </Show>
        }
      >
        {(item) => (
          <Loaded
            {...props}
            item={item()}
            result={result()!}
            favorite={favorite()}
            onFavorite={(value) => void toggleFavorite(item(), value)}
            onStale={() => details.refresh()}
            cloudCopy={cloudId.available() && entryRef(item()) ? () => cloudId.copy(entryRef(item())!) : undefined}
            cloudLabel={cloudIdMessages.resolve([locale()]).t.copy}
          />
        )}
      </Show>
    </Pane>
  );

  async function toggleFavorite(item: FileEntry, value: boolean) {
    try {
      const response = await apiClient.bases[":baseId"].favorite.$post({
        param: { baseId: props.base.id },
        json: { path: item.path, favorite: value },
      });
      if (!response.ok) await apiFailure(response, f().unavailable);
      await details.refresh();
      toast.success(value ? t().favoriteAdded : t().favoriteRemoved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : f().unavailable);
    }
  }
}

function Loaded(
  props: EntryDetailProps & {
    item: FileEntry;
    result: EntryResult;
    favorite: boolean;
    onFavorite: (value: boolean) => void;
    onStale: () => Promise<unknown>;
    cloudCopy?: () => void;
    cloudLabel: string;
  },
) {
  const t = useBrowserMessages();
  const f = useFilesMessages();
  const h = useHistoryMessages();
  const locale = useLocale();
  const versions = createVersions(
    () => props.base,
    () => props.item,
    async () => void (await props.onStale()),
  );
  const readOnly = () => props.item.actions?.write === false;
  const busy = () => props.actions.busy();
  const editable = () => props.actions.editable(props.item);
  const pictured = () => ["image", "pdf", "office"].includes(previewSource(props.item) ?? "");
  const hasPreview = () => !props.item.directory && (pictured() || !!previewKind(props.item));
  const meta = () =>
    props.item.directory
      ? t().kindFolder
      : `${fileKindLabel({ name: props.item.name }, locale())} · ${formatFileViewSize(props.item.size, locale())}`;
  const modified = () =>
    props.history?.env
      ? formatWhen(props.item.modified, locale(), h(), props.history.env)
      : new Date(props.item.modified).toLocaleString(locale());
  const currentAuthor = () => {
    const history = props.history?.initial;
    const request = itemHistoryRequest(props.base, { ...props.item, resourceId: props.item.resourceId ?? props.result.resourceId });
    if (!props.item.revision || history?.source !== itemHistorySource(request)) return null;
    const change = history.page.items.find(
      (change) =>
        change.state === "done" &&
        ["file.create", "file.upload", "file.overwrite", "file.edit", "version.restore"].includes(change.action) &&
        change.after.visibility === "full" &&
        change.after.revision === props.item.revision,
    );
    return change?.actor.kind === "user" ? change.actor.name : null;
  };
  const versionsText = () =>
    versions.state() === "off"
      ? t().versionsUnavailable
      : versions.state() === "ready"
        ? String((versions.items()?.length ?? 0) + 1)
        : versions.state() === "error"
          ? h().versionsFailed
          : t().loadingDetails;
  const openInTab = async () => {
    if (previewKind(props.item) === "pdf") return void window.open(inlinePdfHref(props.base.id, props.item.path), "_blank", "noopener");
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const lease = await contentLease(props.base.id, props.item.path, new AbortController().signal, f().downloadFailed);
      if (tab) tab.location.href = lease.url;
      else window.open(lease.url, "_blank", "noopener");
    } catch (error) {
      tab?.close();
      toast.error(error instanceof Error ? error.message : f().downloadFailed);
    }
  };
  const open = () => {
    if (props.item.directory) return;
    if (editable()) props.onEdit(props.item);
    else props.actions.preview(props.item);
  };
  /** The rarer deeds of the entry; open, download, share and the favorite stand beside them. */
  const menu = (): MenuEntry[] => [
    ...(!props.item.directory ? [{ label: t().openInTab, icon: "external-link", disabled: busy(), onClick: () => void openInTab() }] : []),
    {
      label: t().rename,
      icon: "pencil",
      disabled: busy() || props.item.actions?.move === false,
      onClick: () => void props.actions.rename(props.item),
    },
    { label: t().duplicate, icon: "copy", disabled: busy(), onClick: () => props.actions.duplicate(props.item) },
    {
      label: t().moveTo,
      icon: "arrow-move-right",
      disabled: busy() || props.item.actions?.move === false,
      onClick: () => void props.actions.moveOrCopy([props.item]),
    },
    { label: t().copyTo, icon: "folder-symlink", disabled: busy(), onClick: () => void props.actions.moveOrCopy([props.item], true) },
    ...(props.item.directory && !readOnly()
      ? [{ label: t().shareInbox, icon: "inbox", disabled: busy(), onClick: () => props.onShareInbox(props.item.path) }]
      : []),
    ...(props.cloudCopy ? [{ label: props.cloudLabel, icon: "id", onClick: props.cloudCopy }] : []),
    "separator",
    {
      label: t().trashSelection,
      icon: "trash",
      danger: true,
      disabled: busy() || props.item.actions?.move === false,
      onClick: () => void props.actions.trashItems([props.item]),
    },
  ];
  const folderHref = (path: string) => filesUrl(props.base.id, path);
  return (
    <>
      <Bar
        start={
          <Inline>
            <Text type="meta">{meta()}</Text>
            <Show when={readOnly()}>
              <Chip icon="lock">{t().readOnly}</Chip>
            </Show>
          </Inline>
        }
        end={
          <>
            <Show
              when={props.item.directory}
              fallback={
                <Button icon={editable() ? "pencil" : "eye"} disabled={busy()} onClick={open}>
                  {editable() ? (readOnly() ? t().openReadOnly : t().edit) : t().preview}
                </Button>
              }
            >
              <Button icon="folder-open" href={folderHref(props.item.path)} onNavigate={props.onNavigate}>
                {t().open}
              </Button>
            </Show>
            <Button icon="download" disabled={busy()} onClick={() => props.actions.startDownload([props.item])}>
              {f().download}
            </Button>
            <Show when={props.item.actions?.share !== false}>
              <Button icon="share" variant="ghost" disabled={busy()} onClick={() => props.onShare([props.item.path])}>
                {t().share}
              </Button>
            </Show>
            <Button
              variant="ghost"
              icon="star"
              label={props.favorite ? t().removeFavorite : t().addFavorite}
              pressed={props.favorite}
              disabled={busy()}
              onClick={() => props.onFavorite(!props.favorite)}
            />
            <Menu label={t().moreActions} items={menu()} />
          </>
        }
      />
      <Show when={hasPreview()}>
        {/* The preview leads the detail; a press on it opens it large. Its own viewers keep their behaviour. */}
        <Band>
          <Canvas label={t().expand} height={240}>
            <Show
              when={pictured()}
              fallback={
                <FilePreview
                  variant="plain"
                  pdfFit="page"
                  previewLines={5}
                  onExpandPreview={() => props.actions.preview(props.item)}
                  baseId={props.base.id}
                  locationKey={props.base.locationKey}
                  entry={props.item}
                  onDownload={() => props.actions.startDownload([props.item])}
                />
              }
            >
              <Show keyed when={JSON.stringify([props.base.id, props.base.locationKey, props.item.path, previewRevision(props.item)])}>
                <button type="button" onClick={() => props.actions.preview(props.item)} aria-label={t().expand}>
                  <FileThumbnail baseId={props.base.id} locationKey={props.base.locationKey} entry={props.item} large hero />
                </button>
              </Show>
            </Show>
          </Canvas>
        </Band>
      </Show>
      <Section icon="list-details" title={t().properties}>
        <Facts
          items={[
            { label: t().location, value: `${baseLabel(props.base, t(), locale())} / ${props.item.path}` },
            { label: t().storageArea, value: props.base.area === "cloud" ? t().cloudArea : t().freeipaArea },
            { label: f().modified, value: currentAuthor() ? `${modified()}, ${currentAuthor()}` : modified() },
            ...(!props.item.directory ? [{ label: f().size, value: formatFileViewSize(props.item.size, locale()) }] : []),
            ...(!props.item.directory ? [{ label: t().versions, value: versionsText() }] : []),
          ]}
        />
      </Section>
      <Show when={props.item.directory}>
        <FolderContents base={props.base} folder={props.item} actions={props.actions} onNavigate={props.onNavigate} />
      </Show>
      {/* k2b-ui gap: public links, versions and the item's history are still the v1 parts of the detail; their v2
          rebuild comes with the history views (Files PR 2). Their behaviour stays the same meanwhile. */}
      <Band>
        <Canvas label={h().publicLink}>
          <EntryHistory
            base={props.base}
            entry={props.item}
            resourceId={props.result.resourceId}
            busy={busy()}
            onChanged={(path) => void props.onChanged(path)}
            onOpen={(item) => (item.directory ? undefined : props.actions.preview(item))}
            locale={locale()}
            history={props.history}
            versions={versions}
            currentAuthor={currentAuthor()}
            versionsId={`filesv2-versions-${props.item.path}`}
            versionsOpen
            onShowVersions={() => document.getElementById(`filesv2-versions-${props.item.path}`)?.scrollIntoView({ block: "nearest" })}
          />
        </Canvas>
      </Band>
    </>
  );
}

/** The first entries of a folder, with a way to download each file; the folder itself shows the rest. */
function FolderContents(props: { base: BaseSummary; folder: FileEntry; actions: FolderActions; onNavigate: OnNavigate }) {
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
  const shown = () => page()?.items.slice(0, CONTENTS_SHOWN) ?? [];
  const more = () => (page()?.next || (page()?.items.length ?? 0) > CONTENTS_SHOWN ? true : undefined);
  const meta = (entry: FileEntry) =>
    entry.directory ? t().kindFolder : `${fileKindLabel({ name: entry.name }, locale())} · ${formatFileViewSize(entry.size, locale())}`;
  const href = (entry: FileEntry) =>
    entry.directory ? filesUrl(props.base.id, entry.path) : filesUrl(props.base.id, props.folder.path, null, entry.path);
  return (
    <Section
      icon="folder"
      title={t().contents}
      count={page() && !page()?.next ? page()!.items.length : undefined}
      more={
        more()
          ? { label: t().open, href: filesUrl(props.base.id, props.folder.path), onNavigate: props.onNavigate, forward: true }
          : undefined
      }
    >
      <Show when={!contents.error()} fallback={<Failed text={t().contentsFailed} onRetry={() => void contents.refresh()} />}>
        <Show when={page()} fallback={<Loading rows={3} lines={2} />}>
          <Show when={shown().length} fallback={<Text muted>{t().emptyTitle}</Text>}>
            <List label={t().contents}>
              {shown().map((entry) => (
                <Row
                  icon={entryIcon(entry)}
                  lines={[entry.name, meta(entry)]}
                  href={href(entry)}
                  onNavigate={props.onNavigate}
                  end={
                    entry.directory ? undefined : (
                      <Button
                        variant="ghost"
                        icon="download"
                        label={t().downloadNamed(entry.name)}
                        disabled={props.actions.busy()}
                        onClick={() => props.actions.startDownload([entry])}
                      />
                    )
                  }
                />
              ))}
            </List>
          </Show>
        </Show>
      </Show>
    </Section>
  );
}
