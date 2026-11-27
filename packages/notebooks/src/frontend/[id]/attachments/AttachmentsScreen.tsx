import { saveFiles, saveFilesLabel } from "@k2b/cloud/browser/files";
import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { navigateTo } from "@k2b/ssr/nav";
import { dates, fileIcons } from "@k2b/stdlib";
import { clipboard } from "@k2b/stdlib/browser";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Cells,
  confirm,
  Empty,
  Input,
  List,
  type MarkProps,
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
import type { AttachmentFigures } from "../../../service/notebook-figures";
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
import { withoutAttachment } from "./attachment-figures";
import { attachmentsPageMessages } from "./messages";

export type AttachmentsScreenProps = {
  ctx: NotebookContext;
  attachments: Attachment[];
  total: number;
  /** The notebook's attachment figures, independent of the search: count, bytes, uploads per day. */
  figures: AttachmentFigures;
  search: string;
  page: number;
  pages: number;
  /** The list's address without page and search, with the presentation mode it was opened in. */
  baseHref: string;
  graphBack: string;
  now: string;
};

/** The data colour of a kind of file on its mark, the same in every list; text, code and other files stay neutral. */
const KIND_COLORS: Partial<Record<ReturnType<typeof fileIcons.getFileCategory>, string>> = {
  image: "#059669",
  pdf: "#dc2626",
  video: "#7c3aed",
  audio: "#db2777",
  document: "#2563eb",
  archive: "#ca8a04",
};

/**
 * The mark of a file: its kind's symbol on the kind's colour, and its type in letters ("PDF"). The Tabler name comes
 * from the v1 class `fileIcons` returns ("ti-file-text text-zinc-500").
 */
const markOf = (attachment: Attachment): MarkProps => {
  const file = { name: attachment.filename, type: "file" as const, mimeType: attachment.mimeType };
  const extension = attachment.filename.includes(".") ? attachment.filename.split(".").pop()!.toUpperCase() : "";
  return {
    icon: attachment.kind === "image" ? "photo" : (fileIcons.getFileIcon(file).split(" ")[0] ?? "ti-file").replace(/^ti-/, ""),
    color: KIND_COLORS[fileIcons.getFileCategory(file)],
    kind: extension.length >= 2 && extension.length <= 4 ? extension : undefined,
  };
};

/**
 * The notebook's attachments on v2: one row per file with its kind and size, newest first as the server sends them.
 * A row opens the preview (or offers the download); its "…" downloads, saves to Cloud, copies the Markdown or deletes.
 */
export default function AttachmentsScreen(props: AttachmentsScreenProps) {
  const locale = useLocale();
  const t = createMemo(() => notebookWorkspaceMessages.resolve([locale()]).t);
  const words = createMemo(() => attachmentsPageMessages.resolve([locale()]).t);
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  // the head's figures follow a delete here, so the count, the bytes and the uploads never wait for a reload
  const [figures, setFigures] = createSignal(props.figures);
  const days = () => figures().days.length;
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
      // one sentence: the outcome and, when the server gives one, its reason
      return void toast(body?.message ? t().deleteAttachmentFailedBecause({ reason: body.message }) : t().deleteAttachmentFailed, {
        status: "bad",
      });
    }
    setItems((current) => current.filter((entry) => entry.id !== attachment.id));
    setFigures((current) => withoutAttachment(current, attachment, props.now, props.ctx.dateConfig.timeZone ?? "UTC"));
    // the sidebar's attachments badge reads the notebook's count again
    void sidebar.refreshSnapshot();
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
            // no title: the sidebar's current entry names the page, and on the phone the hero's label does
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
          status={
            <>
              {/* k2b-ui gap: hero band + tinted object head (DP) – the notebook's attachment figure with its real trend
                  stands in Cells until the band (figure 30, the trend as a chart) exists. */}
              <Cells>
                <Cells.Cell
                  icon="paperclip"
                  label={words().attachmentsFigure}
                  value={number(figures().count)}
                  meta={words().addedIn({ count: number(figures().added), days: days() })}
                  trend={{
                    values: figures().days,
                    label: words().uploadsTrend({
                      days: days(),
                      count: number(figures().added),
                      today: number(figures().days.at(-1) ?? 0),
                    }),
                  }}
                />
                <Cells.Cell icon="database" label={words().storage} value={formatBytes(figures().bytes)} />
              </Cells>
              {/* the count of a search: what the search found, once; without one the figure above says it */}
              <Show when={props.search}>
                <StatusRow lead={t().attachmentCount({ count: props.total })} />
              </Show>
            </>
          }
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
            {/* k2b-ui gap: Mark loads its picture at once (no lazy loading) and Notebooks has no thumbnails, so an image
                shows its kind's mark, not its picture, and opens its preview. */}
            <List label={t().attachments}>
              <For each={items()}>
                {(attachment) => (
                  <Menu.Context items={menu(attachment)}>
                    <Row
                      mark={markOf(attachment)}
                      // k2b-ui gap: a Row of one line draws its time and its end (the "…") in one place and keeps its
                      // note beside the title on the phone, so the rows keep two lines (name; size · date) until Row has
                      // B's one line on the desktop and two on the phone (B rule 4).
                      lines={[attachment.filename, `${formatBytes(attachment.sizeBytes)} · ${when(attachment.createdAt)}`]}
                      onOpen={() => openAttachment(notebookId(), attachment, items())}
                      end={<Menu label={t().attachmentActions({ filename: attachment.filename })} items={menu(attachment)} />}
                    />
                  </Menu.Context>
                )}
              </For>
            </List>
          </Show>
          {/* The pages stay reachable also when this page shows none (a deletion, an old link). */}
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
        </Pane>
      </Workspace>
    </>
  );
}
