import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, IconButton, prompts, SettingsCollection, SettingsGroup, TagEditor, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { LocalTag } from "../../service/local-tags";
import type { SavedConversationView } from "../../service/saved-views";
import type { MailboxSettingsContext } from "../../settings-context";
import { readApiError } from "./api-response";
import { openMailSearchBuilder } from "./MailSearchBuilder";
import { summarizeMailSearchExpression } from "./mail-search-builder-model";
import { mailSettingsMessages } from "./mail-settings-messages";

type OrganizationContext = MailboxSettingsContext["organization"];

export default function MailOrganizationSettings(props: {
  mailboxId: string;
  permission: MailboxSettingsContext["permission"];
  initial: OrganizationContext;
  onDirtyChange?: (dirty: boolean) => void;
  onWorkspaceChange: () => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [views, setViews] = createSignal(props.initial.savedViews);
  const [tags, setTags] = createSignal(props.initial.localTags);
  const [tagEditorDirty, setTagEditorDirty] = createSignal(false);
  const canWrite = () => props.permission === "write" || props.permission === "admin";
  let disposed = false;

  createEffect(() => props.onDirtyChange?.(tagEditorDirty()));
  onCleanup(() => {
    disposed = true;
    props.onDirtyChange?.(false);
  });

  const editView = async (existing?: SavedConversationView) => {
    const result = await openMailSearchBuilder({
      mailboxId: props.mailboxId,
      initialState: existing?.filter ?? null,
      initialQuery: "",
      mode: "saved_view",
      initialSavedView: existing ?? null,
      canWrite: canWrite(),
    });
    if (disposed || result?.action !== "saved") return;
    const saved = result.view;
    setViews((current) => (existing ? current.map((view) => (view.id === saved.id ? saved : view)) : [...current, saved]));
    props.onWorkspaceChange();
  };

  const removeViewMutation = mutations.create<string, SavedConversationView>({
    mutation: async (view, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["saved-views"][":viewId"].$delete(
        {
          param: { mailboxId: props.mailboxId, viewId: view.id },
          json: { expectedRevision: view.revision },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedDeleteView));
      return view.id;
    },
    onSuccess: (viewId) => {
      setViews((current) => current.filter((item) => item.id !== viewId));
      props.onWorkspaceChange();
      toast.success(messages().savedViewDeleted);
    },
    onError: (error) => prompts.error(error.message),
  });

  const removeView = async (view: SavedConversationView) => {
    const confirmed = await prompts.confirm(messages().removeViewDescription({ name: view.name }), {
      title: messages().deleteSavedView,
      confirmText: messages().deleteView,
      variant: "danger",
    });
    if (!confirmed || disposed) return;
    await removeViewMutation.mutate(view);
  };

  const saveTag = mutations.create<{ tag: LocalTag; edited: boolean }, { existing?: LocalTag; name: string; color: string }>({
    mutation: async ({ existing, name, color }, { abortSignal }) => {
      const response = existing
        ? await apiClient.mailboxes[":mailboxId"]["local-tags"][":tagId"].$patch(
            {
              param: { mailboxId: props.mailboxId, tagId: existing.id },
              json: { expectedRevision: existing.revision, name, color },
            },
            { init: { signal: abortSignal } },
          )
        : await apiClient.mailboxes[":mailboxId"]["local-tags"].$post(
            {
              param: { mailboxId: props.mailboxId },
              json: { name, color },
            },
            { init: { signal: abortSignal } },
          );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedSaveTag));
      return { tag: await response.json(), edited: Boolean(existing) };
    },
    onSuccess: ({ tag: saved, edited }) => {
      setTags((current) => (edited ? current.map((tag) => (tag.id === saved.id ? saved : tag)) : [...current, saved]));
      props.onWorkspaceChange();
      toast.success(edited ? messages().tagUpdated : messages().tagCreated);
    },
  });

  const removeTagMutation = mutations.create<string, LocalTag>({
    mutation: async (tag, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["local-tags"][":tagId"].$delete(
        {
          param: { mailboxId: props.mailboxId, tagId: tag.id },
          json: { expectedRevision: tag.revision },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedDeleteTag));
      return tag.id;
    },
    onSuccess: (tagId) => {
      setTags((current) => current.filter((item) => item.id !== tagId));
      props.onWorkspaceChange();
      toast.success(messages().tagDeleted);
    },
  });
  onCleanup(() => {
    saveTag.abort();
    removeViewMutation.abort();
    removeTagMutation.abort();
  });

  const removeTag = async (tag: LocalTag) => {
    const confirmed = await prompts.confirm(messages().removeTagDescription({ name: tag.name }), {
      title: messages().deleteTag,
      confirmText: messages().deleteTagAction,
      variant: "danger",
    });
    if (!confirmed || disposed) return;
    await removeTagMutation.mutate(tag);
    if (removeTagMutation.error()) throw removeTagMutation.error();
  };

  const saveTagValue = async (existing: LocalTag | undefined, value: { name: string; color: string }) => {
    await saveTag.mutate({ existing, ...value });
    if (saveTag.error()) throw saveTag.error();
  };

  return (
    <div class="flex flex-col gap-6">
      <SettingsCollection title={messages().savedViews} description={messages().savedViewsDescription} empty={messages().noSavedViews}>
        <SettingsCollection.Action>
          <Button variant="secondary" size="sm" type="button" class="shrink-0 whitespace-nowrap" onClick={() => void editView()}>
            <i class="ti ti-plus" aria-hidden="true" /> {messages().newView}
          </Button>
        </SettingsCollection.Action>
        <For each={views()}>
          {(view) => (
            <SettingsCollection.Item
              title={view.name}
              description={`${view.scope === "private" ? messages().onlyMe : messages().sharedWithMailbox} · ${summarizeMailSearchExpression(view.filter.expression, locale())}`}
              icon={<i class={`ti ${view.scope === "private" ? "ti-user" : "ti-users"}`} aria-hidden="true" />}
            >
              <Show when={view.scope === "private" || canWrite()}>
                <SettingsCollection.Item.Actions>
                  <IconButton size="sm" type="button" label={messages().editNamed({ name: view.name })} onClick={() => void editView(view)}>
                    <i class="ti ti-pencil" aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    size="sm"
                    type="button"
                    label={messages().deleteNamed({ name: view.name })}
                    onClick={() => void removeView(view)}
                  >
                    <i class="ti ti-trash" aria-hidden="true" />
                  </IconButton>
                </SettingsCollection.Item.Actions>
              </Show>
            </SettingsCollection.Item>
          )}
        </For>
      </SettingsCollection>

      <Show when={canWrite()}>
        <SettingsGroup title={messages().conversationTags} description={messages().conversationTagsDescription}>
          <TagEditor
            items={tags()}
            onDirtyChange={setTagEditorDirty}
            disabled={saveTag.loading() || removeTagMutation.loading()}
            labels={{ create: messages().newTag, empty: messages().noConversationTags }}
            onCreate={(value) => saveTagValue(undefined, value)}
            onUpdate={(tag, value) => saveTagValue(tag, value)}
            onDelete={removeTag}
          />
        </SettingsGroup>
      </Show>
    </div>
  );
}
