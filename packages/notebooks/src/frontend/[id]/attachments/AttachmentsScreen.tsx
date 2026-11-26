import { saveFiles, saveFilesLabel } from "@k2b/cloud/browser/files";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { dates, fileIcons } from "@k2b/stdlib";
import { clipboard } from "@k2b/stdlib/browser";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  confirm,
  Empty,
  Input,
  List,
  Menu,
  type MenuEntry,
  Pane,
  Row,
  StatusRow,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { openAttachment } from "../../lib/attachment-preview";
import {
  type Attachment,
  attachmentMarkdown,
  buildAttachmentContentUrl,
  confirmAndDownload,
  formatBytes,
} from "../_components/editor/attachments-client";
import NotebookSidebarBody from "../_components/sidebar/NotebookSidebarBody";
import { useNotebookSidebar } from "../_components/sidebar/notebook-sidebar-state";
import type { NotebookContext } from "../_components/sidebar/types";
import { notebookWorkspaceMessages } from "../messages";

export type AttachmentsScreenProps = {
  ctx: NotebookContext;
  attachments: Attachment[];
  total: number;
  search: string;
  page: number;
  pages: number;
  /** The list's address without page and search, with the presentation mode it was opened in. */
  baseHref: string;
  graphBack: string;
  now: string;
};

/** A Tabler name for a file, from the v1 class `fileIcons` returns ("ti-file-text"). */
const iconOf = (attachment: Attachment) =>
  attachment.kind === "image"
    ? "photo"
    : fileIcons.getFileIcon({ name: attachment.filename, type: "file", mimeType: attachment.mimeType }).replace(/^ti-/, "");

/**
 * The notebook's attachments on v2: one row per file with its kind and size, newest first as the server sends them.
 * A row opens the preview (or offers the download); its "…" downloads, saves to Cloud, copies the Markdown or deletes.
 */
export default function AttachmentsScreen(props: AttachmentsScreenProps) {
  const locale = useLocale();
  const t = createMemo(() => notebookWorkspaceMessages.resolve([locale()]).t);
  const toast = useToast();
  const sidebar = useNotebookSidebar({ ctx: props.ctx, current: "attachments", graphBack: props.graphBack });
  const notebookId = () => props.ctx.notebook.id;
  const [items, setItems] = createSignal(props.attachments);
  const href = (search: string, page = 1) => {
    const url = new URL(props.baseHref, "https://notebooks.invalid");
    if (search) url.searchParams.set("search", search);
    if (page > 1) url.searchParams.set("page", String(page));
    return `${url.pathname}${url.search}`;
  };
  const when = (at: string) => dates.formatDateRelative(at, { ...props.ctx.dateConfig, base: props.now });

  const copy = async (attachment: Attachment) => {
    try {
      await clipboard.copy(attachmentMarkdown({ id: attachment.id, kind: attachment.kind, filename: attachment.filename }));
      toast(t().attachmentMarkdownCopied, { status: "ok" });
    } catch {
      toast(t().attachmentMarkdownCopyFailed, { status: "bad" });
    }
  };

  /** Asks first, and names how many notes still show the file; the list drops the row once the server deleted it. */
  const remove = async (attachment: Attachment) => {
    const usage = await apiClient[":id"].attachments[":attId"].usage.$get({ param: { id: notebookId(), attId: attachment.id } });
    if (!usage.ok) return void toast(t().attachmentUsageFailed, { status: "bad" });
    const { count } = await usage.json();
    const agreed = await confirm({
      title: t().deleteAttachment,
      description:
        count > 0
          ? t().deleteReferencedAttachmentConfirm({ filename: attachment.filename, count })
          : t().deleteAttachmentConfirm({ filename: attachment.filename }),
      confirm: t().delete,
    });
    if (!agreed) return;
    const deleted = await apiClient[":id"].attachments[":attId"].$delete({ param: { id: notebookId(), attId: attachment.id } });
    if (!deleted.ok) {
      const body = (await deleted.json().catch(() => null)) as { message?: string } | null;
      return void toast(body?.message ?? t().deleteAttachmentFailed, { status: "bad" });
    }
    setItems((current) => current.filter((entry) => entry.id !== attachment.id));
  };

  const menu = (attachment: Attachment): MenuEntry[] => {
    const url = buildAttachmentContentUrl(notebookId(), attachment.id);
    return [
      { label: t().downloadAttachment, icon: "download", onClick: () => void confirmAndDownload(attachment.filename, url) },
      {
        label: saveFilesLabel(locale(), { name: attachment.filename }),
        icon: "cloud-upload",
        onClick: () =>
          void saveFiles([{ name: attachment.filename, content: url, mediaType: attachment.mimeType, size: attachment.sizeBytes }]),
      },
      { label: t().copyAttachmentMarkdown, icon: "copy", onClick: () => copy(attachment) },
      { label: t().deleteAttachment, icon: "trash", danger: true, onClick: () => remove(attachment) },
    ];
  };

  const search = (text: string) => void navigateTo(href(text.trim()));

  return (
    <>
      {/* k2b-ui gap: Nav tree – the phone menu keeps the v1 navigation with the whole tree and its note menus. */}
      <WorkspaceNavigationProvider navigation={sidebar.mobileNavigation} label={props.ctx.notebook.name} />
      <Workspace
        // k2b-ui gap: Nav tree (link + fold, lazy levels, drag and drop) – the v1 sidebar body stands in the slot.
        sidebar={<NotebookSidebarBody sidebar={sidebar} current="attachments" />}
        head={
          <Bar
            start={<Text type="body">{t().attachments}</Text>}
            end={
              <Input
                type="search"
                icon="search"
                label={t().searchAttachmentsLabel}
                placeholder={t().searchAttachments}
                value={props.search}
                onKeyDown={(event) => {
                  if (event.isComposing) return;
                  const input = event.currentTarget as HTMLInputElement;
                  if (event.key === "Enter") search(input.value);
                  if (event.key === "Escape" && input.value) search("");
                }}
              />
            }
          />
        }
      >
        <Pane
          label={t().attachments}
          scrollKey={`notebooks-attachments-${notebookId()}`}
          status={<StatusRow lead={t().attachmentCount({ count: props.total })} />}
        >
          <Show
            when={items().length > 0}
            fallback={
              props.search ? (
                <Empty
                  icon="filter-off"
                  text={t().noMatchingAttachments({ query: props.search })}
                  action={{ label: t().clearSearch, icon: "x", href: href("") }}
                />
              ) : (
                <Empty icon="paperclip" text={`${t().noAttachments} ${t().noAttachmentsDescription}`} />
              )
            }
          >
            {/* k2b-ui gap: Row has no image thumbnail; an image shows its kind's symbol and opens its preview. */}
            <List label={t().attachments}>
              <For each={items()}>
                {(attachment) => (
                  <Menu.Context items={menu(attachment)}>
                    <Row
                      icon={iconOf(attachment)}
                      lines={[attachment.filename, `${formatBytes(attachment.sizeBytes)} · ${attachment.mimeType}`]}
                      time={when(attachment.createdAt)}
                      onOpen={() => openAttachment(notebookId(), attachment, items())}
                      end={<Menu label={t().attachmentActions({ filename: attachment.filename })} items={menu(attachment)} />}
                    />
                  </Menu.Context>
                )}
              </For>
            </List>
            <Show when={props.pages > 1}>
              <Bar
                start={<Text type="meta">{t().pageOf({ page: props.page, pages: props.pages })}</Text>}
                end={
                  <>
                    <Button icon="chevron-left" href={href(props.search, props.page - 1)} disabled={props.page <= 1}>
                      {t().previousPage}
                    </Button>
                    <Button href={href(props.search, props.page + 1)} disabled={props.page >= props.pages} forward>
                      {t().nextPage}
                    </Button>
                  </>
                }
              />
            </Show>
          </Show>
        </Pane>
      </Workspace>
    </>
  );
}
