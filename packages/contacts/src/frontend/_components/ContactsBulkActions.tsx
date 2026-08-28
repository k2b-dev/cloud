import { documentNavigate } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, dialogCore, IconButton, MultiSelectInput, PanelDialog, panelDialogOptions, prompts, Tooltip, toast, useLocale } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import { apiClient } from "@/api/client";
import type { ContactTag } from "../../service";
import { readErrorMessage } from "./api";
import { type ResultsMessages, resultsMessages } from "./results-messages";

type BookOption = { id: string; name: string };

type BulkIntent =
  | { action: "tags"; bookId: string; contactIds: string[]; tagIds: string[] }
  | { action: "move"; bookId: string; contactIds: string[]; targetBookId: string }
  | { action: "export"; bookId: string; contactIds: string[] }
  | { action: "delete"; bookId: string; contactIds: string[] };

type BulkResult = { action: "tags" | "move" | "delete"; contactCount: number } | { action: "export"; blob: Blob };

const saveBlob = (blob: Blob, filename: string) => {
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(href), 0);
};

const chooseTags = (tags: ContactTag[], t: ResultsMessages) =>
  dialogCore.open<string[] | null>((close) => {
    const [selected, setSelected] = createSignal<string[]>([]);
    return (
      <PanelDialog>
        <PanelDialog.Header title={t.addTags} subtitle={t.addTagsSubtitle} icon="ti ti-tags" close={() => close(null)} />
        <PanelDialog.Body>
          <MultiSelectInput
            label={t.tagsLabel}
            placeholder={t.chooseTags}
            icon="ti ti-tags"
            value={selected}
            onValueChange={setSelected}
            options={tags.map((tag) => ({ id: tag.id, label: tag.name, color: tag.color }))}
            clearable
          />
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <span />
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => close(null)}>
              {t.cancel}
            </Button>
            <Button size="sm" disabled={selected().length === 0} onClick={() => close(selected())}>
              {t.addTags}
            </Button>
          </div>
        </PanelDialog.Footer>
      </PanelDialog>
    );
  }, panelDialogOptions);

export default function ContactsBulkActions(props: {
  bookId: string;
  selectedIds: () => string[];
  visibleIds: () => string[];
  tags: ContactTag[];
  writableBooks: BookOption[];
  onSelectVisible: () => void;
  onClear: () => void;
  onChanged: () => Promise<void> | void;
}) {
  const locale = useLocale();
  const t = () => resultsMessages.resolve([locale()]).t;
  const [preparing, setPreparing] = createSignal(false);
  let disposed = false;

  const runMutation = mutations.create<BulkResult, BulkIntent>({
    mutation: async (intent, { abortSignal }) => {
      if (intent.action === "tags") {
        const response = await apiClient.books[":bookId"].contacts.bulk.tags.$post(
          {
            param: { bookId: intent.bookId },
            json: { contactIds: intent.contactIds, tagIds: intent.tagIds },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readErrorMessage(response, t().couldNotAddTags));
        return { action: "tags", contactCount: intent.contactIds.length };
      }

      if (intent.action === "move") {
        const response = await apiClient.books[":bookId"].contacts.bulk.move.$post(
          {
            param: { bookId: intent.bookId },
            json: { contactIds: intent.contactIds, targetBookId: intent.targetBookId },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readErrorMessage(response, t().couldNotMoveContacts));
        return { action: "move", contactCount: intent.contactIds.length };
      }

      if (intent.action === "export") {
        const response = await apiClient.books[":bookId"].contacts.bulk["export.vcf"].$post(
          {
            param: { bookId: intent.bookId },
            json: { contactIds: intent.contactIds },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readErrorMessage(response, t().couldNotExportContacts));
        return { action: "export", blob: await response.blob() };
      }

      const response = await apiClient.books[":bookId"].contacts.bulk.delete.$post(
        {
          param: { bookId: intent.bookId },
          json: { contactIds: intent.contactIds },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().couldNotDeleteContacts));
      return { action: "delete", contactCount: intent.contactIds.length };
    },
    onSuccess: (result) => {
      if (result.action === "export") {
        saveBlob(result.blob, "contacts-selection.vcf");
        return;
      }

      if (result.action === "tags") {
        toast.success(t().tagsAddedToContacts({ count: result.contactCount }));
      } else if (result.action === "move") {
        toast.success(t().contactsMoved({ count: result.contactCount }));
      } else {
        toast.success(t().contactsDeleted({ count: result.contactCount }));
      }

      props.onClear();
      void Promise.resolve()
        .then(() => props.onChanged())
        .catch(() => {
          documentNavigate(`${window.location.pathname}${window.location.search}`, { replace: true });
        });
    },
    onError: (error) => void prompts.error(error.message),
  });

  onCleanup(() => {
    disposed = true;
    runMutation.abort();
  });

  const prepare = async (action: BulkIntent["action"]) => {
    if (preparing() || runMutation.loading()) return;
    const bookId = props.bookId;
    const contactIds = [...props.selectedIds()];
    if (contactIds.length === 0) return;
    const tags = [...props.tags];
    const writableBooks = [...props.writableBooks];

    setPreparing(true);
    try {
      if (action === "tags") {
        if (tags.length === 0) {
          await prompts.alert(t().noTagsAvailableHint, {
            title: t().noTagsAvailable,
            icon: "ti ti-tags-off",
          });
          return;
        }
        const tagIds = await chooseTags(tags, t());
        if (tagIds && !disposed) void runMutation.mutate({ action, bookId, contactIds, tagIds: [...tagIds] });
        return;
      }

      if (action === "move") {
        const targets = writableBooks.filter((book) => book.id !== bookId);
        if (targets.length === 0) {
          await prompts.alert(t().noTargetBookHint, { title: t().noTargetBook, icon: "ti ti-folder-off" });
          return;
        }
        const result = await prompts.form({
          title: t().moveContactsTitle({ count: contactIds.length }),
          icon: "ti ti-folder-symlink",
          confirmText: t().moveAction,
          fields: {
            targetBookId: {
              type: "select",
              label: t().targetBook,
              description: t().moveConsequence,
              required: true,
              options: targets.map((book) => ({ id: book.id, label: book.name, icon: "ti ti-address-book" })),
            },
          },
        });
        if (result && !disposed) void runMutation.mutate({ action, bookId, contactIds, targetBookId: result.targetBookId });
        return;
      }

      if (action === "delete") {
        const confirmed = await prompts.confirm(t().deleteContactsConfirm({ count: contactIds.length }), {
          title: t().deleteContactsTitle,
          icon: "ti ti-trash",
          confirmText: t().deleteAction,
          variant: "danger",
        });
        if (confirmed && !disposed) void runMutation.mutate({ action, bookId, contactIds });
        return;
      }

      if (!disposed) void runMutation.mutate({ action, bookId, contactIds });
    } catch (error) {
      if (!disposed) void prompts.error(error instanceof Error ? error.message : t().couldNotPrepareBulkAction);
    } finally {
      if (!disposed) setPreparing(false);
    }
  };

  const noSelection = () => props.selectedIds().length === 0;
  const busy = () => preparing() || runMutation.loading();

  return (
    <div class="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-selected)] p-2">
      <span class="mr-auto text-xs font-medium text-primary tabular-nums">{t().selectedCount({ count: props.selectedIds().length })}</span>
      <Button variant="ghost" size="sm" onClick={props.onSelectVisible} disabled={props.visibleIds().length === 0}>
        {t().selectPage}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void prepare("tags")} disabled={busy() || noSelection()}>
        <i class="ti ti-tags" /> {t().tagAction}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void prepare("move")} disabled={busy() || noSelection()}>
        <i class="ti ti-folder-symlink" /> {t().moveAction}
      </Button>
      <Button variant="ghost" size="sm" onClick={() => void prepare("export")} disabled={busy() || noSelection()}>
        <i class="ti ti-download" /> {t().exportAction}
      </Button>
      <Button variant="danger" size="sm" onClick={() => void prepare("delete")} disabled={busy() || noSelection()}>
        <i class="ti ti-trash" /> {t().deleteAction}
      </Button>
      <Tooltip.Anchor content={t().exitSelection}>
        <IconButton size="xs" label={t().exitSelection} onClick={props.onClear}>
          <i class="ti ti-x" />
        </IconButton>
      </Tooltip.Anchor>
    </div>
  );
}
