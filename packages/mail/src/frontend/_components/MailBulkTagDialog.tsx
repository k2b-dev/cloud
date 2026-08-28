import { Button, MultiSelectInput, Placeholder, prompts, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { LocalTag } from "../../service/local-tags";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

export const chooseBulkTags = (tags: LocalTag[]): Promise<string[] | null | undefined> => {
  const t = mailConversationUiMessages.resolve([useLocale()()]).t;
  return prompts.dialog<string[] | null>(
    (close) => {
      const [selectedTagIds, setSelectedTagIds] = createSignal<string[]>([]);
      return (
        <div class="flex flex-col gap-4">
          <Show
            when={tags.length > 0}
            fallback={<Placeholder icon="ti ti-tags-off" title={t.noTags} description={t.createTagFromDetails} />}
          >
            <p class="text-sm text-secondary">{t.chooseTagsHint}</p>
            <MultiSelectInput
              label={t.tags}
              icon="ti ti-tags"
              placeholder={t.chooseTags}
              value={selectedTagIds}
              onValueChange={setSelectedTagIds}
              options={tags.map((tag) => ({ id: tag.id, label: tag.name, icon: "ti ti-tag", color: tag.color }))}
            />
          </Show>
          <div class="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => close(null)}>
              {t.cancel}
            </Button>
            <Button size="sm" type="button" disabled={selectedTagIds().length === 0} onClick={() => close(selectedTagIds())}>
              <i class="ti ti-tags" aria-hidden="true" /> {t.addTags}
            </Button>
          </div>
        </div>
      );
    },
    { title: t.addTags, icon: "ti ti-tags", size: "medium" },
  );
};

export const chooseConversationTags = (tags: LocalTag[], selectedTags: LocalTag[]): Promise<string[] | null | undefined> => {
  const t = mailConversationUiMessages.resolve([useLocale()()]).t;
  return prompts.dialog<string[] | null>(
    (close) => {
      const [selectedTagIds, setSelectedTagIds] = createSignal(selectedTags.map((tag) => tag.id));
      return (
        <div class="flex flex-col gap-4">
          <Show
            when={tags.length > 0}
            fallback={<Placeholder icon="ti ti-tags-off" title={t.noTags} description={t.createTagInSettings} />}
          >
            <MultiSelectInput
              label={t.tags}
              icon="ti ti-tags"
              placeholder={t.chooseTags}
              value={selectedTagIds}
              onValueChange={setSelectedTagIds}
              options={tags.map((tag) => ({ id: tag.id, label: tag.name, icon: "ti ti-tag", color: tag.color }))}
              selectedOptions={() => selectedTags.map((tag) => ({ id: tag.id, label: tag.name, icon: "ti ti-tag", color: tag.color }))}
              clearable
            />
          </Show>
          <div class="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => close(null)}>
              {t.cancel}
            </Button>
            <Button size="sm" type="button" disabled={tags.length === 0} onClick={() => close(selectedTagIds())}>
              <i class="ti ti-check" aria-hidden="true" /> {t.saveTags}
            </Button>
          </div>
        </div>
      );
    },
    { title: t.conversationTags, icon: "ti ti-tags", size: "medium" },
  );
};
