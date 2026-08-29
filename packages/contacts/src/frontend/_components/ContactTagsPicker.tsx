import { query } from "@k2b/stdlib/solid";
import { Button, MultiSelectInput, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { ContactTag } from "../../service";
import { safeTagColor } from "../../shared";
import { detailMessages } from "./detail-messages";
import { currentSourceValue, type SourceTagged } from "./lazy-query-source";

type Props = {
  bookId: string;
  /** Tag ids currently assigned. */
  selectedIds: string[];
  /** Called with the complete selected id list after each change. */
  onChange: (ids: string[]) => void;
  loading?: boolean;
  /** Compact trigger when used inside a contact editor row — hides the
   *  outer label, just renders the trigger pill. */
  compact?: boolean;
  /** Opens tag management when the book has no tags. Return true to reload. */
  onManage?: () => boolean | void | Promise<boolean | void>;
};

/**
 * Multi-select tag picker. Tags themselves are managed in the book settings
 * dialog — here we only assign / unassign existing ones to the current contact.
 */
export default function ContactTagsPicker(props: Props) {
  const locale = useLocale();
  const t = () => detailMessages.resolve([locale()]).t;
  const [managing, setManaging] = createSignal(false);

  const available = query.create<string, SourceTagged<ContactTag[]>>({
    source: () => props.bookId,
    load: async (bookId, ctx) => {
      const res = await apiClient.books[":bookId"].tags.$get({ param: { bookId } }, { init: { signal: ctx.abortSignal } });
      if (!res.ok) throw new Error(t().couldNotLoadTags);
      return { source: bookId, value: await res.json() };
    },
  });
  const currentTags = () => currentSourceValue(props.bookId, available.data());

  const manageTags = async () => {
    if (!props.onManage || managing()) return;
    setManaging(true);
    try {
      if (await props.onManage()) {
        await available.invalidate().catch(() => undefined);
      }
    } finally {
      setManaging(false);
    }
  };

  const selectedIds = () => (currentTags() ? props.selectedIds.filter((id) => currentTags()!.some((tag) => tag.id === id)) : []);
  const options = () =>
    (currentTags() ?? []).map((tag) => ({
      id: tag.id,
      label: tag.name,
      icon: "ti ti-tag",
      color: safeTagColor(tag.color),
    }));

  return (
    <div class="flex flex-col gap-1.5">
      <MultiSelectInput
        label={props.compact ? undefined : t().tags}
        aria-label={props.compact ? t().tags : undefined}
        value={selectedIds}
        options={options()}
        placeholder={available.loading() ? t().loadingTags : t().noTags}
        searchPlaceholder={t().searchTags}
        emptyLabel={t().noTagsInBook}
        disabled={props.loading || available.loading() || !currentTags()}
        clearable
        onValueChange={props.onChange}
      />
      <Show when={available.error()}>
        <div class="flex items-center justify-between gap-2 text-xs text-red-600 dark:text-red-400">
          <span>{t().couldNotLoadTags}</span>
          <Button type="button" variant="ghost" size="xs" onClick={() => void available.refresh()}>
            {t().retry}
          </Button>
        </div>
      </Show>
      <Show when={currentTags() && currentTags()!.length === 0 && props.onManage}>
        <Button type="button" variant="ghost" size="xs" class="w-fit" loading={managing()} onClick={() => void manageTags()}>
          <i class="ti ti-settings" aria-hidden="true" />
          {t().manageTagsInBookSettings}
        </Button>
      </Show>
    </div>
  );
}
