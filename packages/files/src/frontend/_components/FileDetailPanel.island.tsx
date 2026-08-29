import { dates, fileIcons, text } from "@k2b/stdlib";
import { Button, DescriptionList, DetailPanel, IconButton, Placeholder, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { FileBaseInfo, FileInfo } from "@/contracts";
import { DETAIL_FILE_SELECT_EVENT, type DetailFileSelectPayload, fileApiUrl, setDetailFileInUrl } from "./context";
import { type buildFileMenuElements, canOpenFileInline, createFileActionMutations, type FileActionContext } from "./FileActions";
import { filesMessages } from "../messages";

type FileDetailPanelProps = {
  initialFile: FileInfo | null;
  initialFilePath: string | null;
  initialBaseType: string;
  initialBaseId: string;
  items: FileInfo[];
  bases: FileBaseInfo[];
  useFullDetailKey?: boolean;
  showEmpty?: boolean;
};

type FileActionEntry = Extract<ReturnType<typeof buildFileMenuElements>[number], { label: string }>;

const asFileBaseType = (value: string): FileBaseInfo["type"] => (value === "group" ? "group" : "home");

const isActionEntry = (entry: ReturnType<typeof buildFileMenuElements>[number]): entry is FileActionEntry => "label" in entry;

const parseFullDetailKey = (key: string) => {
  const firstColon = key.indexOf(":");
  const secondColon = key.indexOf(":", firstColon + 1);
  if (firstColon > 0 && secondColon > firstColon) {
    return {
      baseType: key.substring(0, firstColon),
      baseId: key.substring(firstColon + 1, secondColon),
      path: key.substring(secondColon + 1),
    };
  }
  return null;
};

export default function FileDetailPanel(props: FileDetailPanelProps) {
  const locale = useLocale();
  const t = () => filesMessages.resolve([locale()]).t;
  const fileActions = createFileActionMutations();
  const [file, setFile] = createSignal<FileInfo | null>(props.initialFile);
  const [filePath, setFilePath] = createSignal<string | null>(props.initialFilePath);
  const [baseType, setBaseType] = createSignal(props.initialBaseType);
  const [baseId, setBaseId] = createSignal(props.initialBaseId);

  onMount(() => {
    const handleSelect = (e: Event) => {
      const payload = (e as CustomEvent<DetailFileSelectPayload>).detail;
      setFile(payload.item);
      setFilePath(payload.itemKey);
      setBaseType(payload.baseType);
      setBaseId(payload.baseId);
    };

    const handlePopState = () => {
      const url = new URL(window.location.href);
      const key = url.searchParams.get("file");
      if (!key) {
        setFile(null);
        setFilePath(null);
        return;
      }

      if (props.useFullDetailKey) {
        const parsed = parseFullDetailKey(key);
        if (!parsed) return;
        const found = props.items.find((item) => item.path === parsed.path);
        setFile(found ?? null);
        setFilePath(key);
        setBaseType(parsed.baseType);
        setBaseId(parsed.baseId);
        return;
      }

      const found = props.items.find((item) => {
        const itemPath = item.path || `${props.initialBaseType}/${props.initialBaseId}/${item.name}`;
        return itemPath === key || item.name === key.split("/").pop();
      });
      setFile(found ?? null);
      setFilePath(key);
    };

    window.addEventListener(DETAIL_FILE_SELECT_EVENT, handleSelect);
    window.addEventListener("popstate", handlePopState);
    onCleanup(() => {
      window.removeEventListener(DETAIL_FILE_SELECT_EVENT, handleSelect);
      window.removeEventListener("popstate", handlePopState);
    });
  });

  const isDirectory = () => file()?.type === "directory";
  const category = () => (file() ? fileIcons.getFileCategory(file()!) : "other");
  const icon = () => (file() ? fileIcons.getFileIcon(file()!) : "ti-file");
  const categoryLabel = () => {
    switch (category()) {
      case "image":
        return t().image;
      case "pdf":
        return t().pdf;
      case "video":
        return t().video;
      case "audio":
        return t().audio;
      case "text":
        return t().textFile;
      case "code":
        return t().sourceCode;
      case "document":
        return t().document;
      case "archive":
        return t().archive;
      default:
        return t().file;
    }
  };

  const itemPath = () => {
    const currentPath = filePath();
    if (!currentPath) return "";
    if (props.useFullDetailKey) {
      const parsed = parseFullDetailKey(currentPath);
      return parsed?.path ?? currentPath;
    }
    return currentPath;
  };

  const detailScrollPreserveKey = () =>
    `files-detail-${baseType() || "none"}-${encodeURIComponent(baseId() || "none")}-${encodeURIComponent(itemPath() || "empty")}`;

  const contentUrl = () => `${fileApiUrl(baseType(), baseId())}/content?path=${encodeURIComponent(itemPath())}`;
  const actionContext = createMemo<FileActionContext>(() => ({
    baseType: asFileBaseType(baseType()),
    baseId: baseId(),
    bases: props.bases,
  }));

  const handleClose = () => setDetailFileInUrl(null);

  const fullPath = () => {
    const baseName = baseType() === "home" ? "~" : baseId();
    const path = itemPath();
    return `${baseName}${path.startsWith("/") ? "" : "/"}${path}`;
  };

  const detailSubtitle = () => {
    const currentFile = file();
    if (!currentFile || currentFile.type === "directory") return t().folder;
    return `${categoryLabel()} · ${text.pprintBytes(currentFile.size)} · ${dates.formatDateTimeRelative(currentFile.mtime)}`;
  };

  const closeAction = () => (
    <Tooltip.Anchor content={t().closeDetails}>
      <IconButton onClick={handleClose} label={t().closeDetailPanel} size="sm" variant="ghost">
        <i class="ti ti-x" aria-hidden="true" />
      </IconButton>
    </Tooltip.Anchor>
  );

  const actionItems = createMemo<FileActionEntry[]>(() => {
    const currentFile = file();
    if (!currentFile) return [];
    const items = fileActions
      .buildFileMenuElements({
        item: currentFile,
        itemPath: itemPath(),
        ctx: actionContext(),
        onCloseDetail: handleClose,
      })
      .filter(isActionEntry);
    return items.slice(1);
  });

  const runAction = (entry: FileActionEntry) => {
    if ("action" in entry && entry.action) {
      void entry.action();
      return;
    }
    if ("href" in entry && entry.href) {
      window.open(entry.href, entry.external ? "_blank" : "_self");
    }
  };

  return (
    <Show
      when={file()}
      fallback={
        props.showEmpty === false ? null : (
          <Placeholder icon="ti ti-file-info" class="h-full min-h-0 justify-center" description={<>{t().selectForDetails}</>} />
        )
      }
    >
      {(currentFile) => (
        <DetailPanel>
          <Show
            when={category() === "image" && !isDirectory()}
            fallback={
              <DetailPanel.Header
                class="[view-transition-name:files-detail-panel]"
                icon={`ti ${icon()}`}
                title={<span class="break-all">{currentFile().name}</span>}
                subtitle={detailSubtitle()}
                actions={closeAction()}
              />
            }
          >
            <DetailPanel.Header
              class="[view-transition-name:files-detail-panel]"
              leading={
                <img
                  src={`${contentUrl()}&inline=true`}
                  alt={currentFile().name}
                  class="h-8 w-8 rounded-[var(--ui-radius-control)] object-cover"
                />
              }
              title={<span class="break-all">{currentFile().name}</span>}
              subtitle={detailSubtitle()}
              actions={closeAction()}
            />
          </Show>

          <DetailPanel.Body scrollPreserveKey={detailScrollPreserveKey()}>
            <DetailPanel.Summary title={t().details}>
              <DescriptionList
                layout="rows"
                size="sm"
                items={[
                  { term: t().path, description: <span class="break-all font-mono">{fullPath()}</span> },
                  { term: t().kind, description: isDirectory() ? t().folder : categoryLabel() },
                  { term: t().modified, description: dates.formatDateTime(currentFile().mtime) },
                  ...(!isDirectory() ? [{ term: t().size, description: text.pprintBytes(currentFile().size) }] : []),
                ]}
              />
            </DetailPanel.Summary>

            <Show when={actionItems().length > 0}>
              <DetailPanel.Section title={t().actions} icon="ti ti-bolt" tone="accent">
                <div class="flex flex-col gap-0.5">
                  <For each={actionItems()}>
                    {(entry) => {
                      const label = () => (entry.icon === "ti ti-eye" && canOpenFileInline(currentFile()) ? t().preview : entry.label);
                      return entry.variant === "danger" ? (
                        <Button variant="danger" size="sm" class="justify-start" title={entry.label} onClick={() => runAction(entry)}>
                          {entry.icon && <i class={entry.icon} aria-hidden="true" />}
                          <span>{label()}</span>
                        </Button>
                      ) : (
                        <DetailPanel.Action
                          type="button"
                          onClick={() => runAction(entry)}
                          leading={entry.icon ? <i class={entry.icon} aria-hidden="true" /> : undefined}
                          title={label()}
                        />
                      );
                    }}
                  </For>
                </div>
              </DetailPanel.Section>
            </Show>
          </DetailPanel.Body>
        </DetailPanel>
      )}
    </Show>
  );
}
