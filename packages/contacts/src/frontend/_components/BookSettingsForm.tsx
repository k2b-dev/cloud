import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  confirmDiscardIfDirty,
  prompts,
  SettingsField,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  TagEditor,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { type GrantableLevel, PermissionEditor, type ResourceApiKey, ResourceApiKeys } from "@valentinkolb/cloud/access/ui";
import type { AccessEntry, Principal } from "@valentinkolb/cloud/contracts";
import { createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { ContactBook, ContactTag } from "../../service";
import { readErrorMessage } from "./api";
import BookActions from "./BookActions";
import { bookMessages } from "./book-messages";
import type { BookSettingsContext } from "./BookSettingsDialog";
import { createBlockedReconciliation, createQueuedReconciliation, settingsInteractionBlocked } from "./book-settings-reconcile";
import DeleteBookButton from "./DeleteBookButton";

type Props = {
  context: () => BookSettingsContext;
  initialTab?: string;
  onClose: () => void;
  onDeleted: () => void;
  onWorkspaceChange: () => void;
  onReconcile: () => Promise<void>;
};

/** Contact book settings for book administrators. */
export default function BookSettingsForm(props: Props) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const bookId = () => props.context().book.id;
  const [activeTab, setActiveTab] = createSignal(props.initialTab ?? "general");
  const [savedName, setSavedName] = createSignal(props.context().book.name);
  const [savedDescription, setSavedDescription] = createSignal(props.context().book.description ?? "");
  const [name, setName] = createSignal(savedName());
  const [description, setDescription] = createSignal(savedDescription());
  const [tagEditorDirty, setTagEditorDirty] = createSignal(false);
  const [reconcileError, setReconcileError] = createSignal<string | null>(null);
  const [settingsReconciling, setSettingsReconciling] = createSignal(false);
  const [ownerRequestCount, setOwnerRequestCount] = createSignal(0);
  const [deleteBookPending, setDeleteBookPending] = createSignal(false);
  const [tagReconcileError, setTagReconcileError] = createSignal<string | null>(null);
  const [tagReconciling, setTagReconciling] = createSignal(false);
  let deleteTagConfirming = false;
  let navigationPromptPending = false;
  let disposed = false;

  const nameChanged = () => name() !== savedName();
  const descriptionChanged = () => description() !== savedDescription();
  const changeCount = () => Number(nameChanged()) + Number(descriptionChanged());
  const nameError = () => (name().trim() ? undefined : t().bookNameRequired);
  const discardMetadata = () => {
    setName(savedName());
    setDescription(savedDescription());
  };

  const settingsCoverage = createQueuedReconciliation(props.onReconcile, (state) => {
    setSettingsReconciling(state.reconciling);
    setReconcileError(state.error);
  });
  const reconcile = settingsCoverage.run;
  const coverageBlocked = () => settingsReconciling() || reconcileError() !== null;

  const updateMutation = mutations.create<ContactBook, { bookId: string; name: string; description: string | null }>({
    mutation: async (input, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].$patch(
        {
          param: { bookId: input.bookId },
          json: { name: input.name, description: input.description },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().updateBookFailed));
      return response.json();
    },
    onSuccess: (book) => {
      const nextDescription = book.description ?? "";
      setName(book.name);
      setDescription(nextDescription);
      setSavedName(book.name);
      setSavedDescription(nextDescription);
      props.onWorkspaceChange();
      toast.success(t().bookSettingsSaved);
      reconcile(t().settingsSavedReloadFailed);
    },
    onError: (error) => prompts.error(error.message),
  });
  const saveMetadata = () => {
    if (disposed || settingsBusy()) return;
    const trimmedName = name().trim();
    if (!trimmedName) return;
    void updateMutation.mutate({ bookId: bookId(), name: trimmedName, description: description().trim() || null });
  };

  type TagValue = { name: string; color: string };
  const createTagMutation = mutations.create<ContactTag, { bookId: string; value: TagValue }>({
    mutation: async (input, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].tags.$post(
        { param: { bookId: input.bookId }, json: input.value },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().createTagFailed));
      return response.json();
    },
  });

  const updateTagMutation = mutations.create<ContactTag, { bookId: string; tagId: string; value: TagValue }>({
    mutation: async (input, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].tags[":tagId"].$patch(
        { param: { bookId: input.bookId, tagId: input.tagId }, json: input.value },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().updateTagFailed));
      return response.json();
    },
  });

  const deleteTagMutation = mutations.create<void, { bookId: string; tagId: string }>({
    mutation: async (input, { abortSignal }) => {
      const response = await apiClient.books[":bookId"].tags[":tagId"].$delete(
        { param: { bookId: input.bookId, tagId: input.tagId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().deleteTagFailed));
    },
  });
  const tagOperationPending = () =>
    createTagMutation.loading() ||
    updateTagMutation.loading() ||
    deleteTagMutation.loading() ||
    tagReconciling() ||
    tagReconcileError() !== null;

  const tagCoverage = createBlockedReconciliation(props.onReconcile, (state) => {
    setTagReconciling(state.reconciling);
    setTagReconcileError(state.error);
  });

  const completeTagWrite = async (successMessage: string, failureMessage: string) => {
    props.onWorkspaceChange();
    await tagCoverage.run(failureMessage);
    if (!disposed) toast.success(successMessage);
  };

  const createTag = async (value: TagValue) => {
    if (disposed || settingsBusy()) return;
    await createTagMutation.mutate({ bookId: bookId(), value: { ...value } });
    if (disposed) return;
    if (createTagMutation.error()) throw createTagMutation.error();
    await completeTagWrite(t().tagCreated, t().tagCreatedReloadFailed);
  };
  const updateTag = async (tag: ContactTag, value: TagValue) => {
    if (disposed || settingsBusy()) return;
    await updateTagMutation.mutate({ bookId: bookId(), tagId: tag.id, value: { ...value } });
    if (disposed) return;
    if (updateTagMutation.error()) throw updateTagMutation.error();
    await completeTagWrite(t().tagUpdated, t().tagUpdatedReloadFailed);
  };

  const deleteTag = async (tag: ContactTag) => {
    if (disposed || settingsBusy()) return;
    deleteTagConfirming = true;
    try {
      const confirmed = await prompts.confirm(t().deleteTagConfirm({ name: tag.name }), {
        title: t().deleteTagTitle,
        icon: "ti ti-trash",
        variant: "danger",
        confirmText: t().delete,
      });
      if (!confirmed || disposed) return;

      await deleteTagMutation.mutate({ bookId: bookId(), tagId: tag.id });
      if (disposed) return;
      if (deleteTagMutation.error()) throw deleteTagMutation.error();
      await completeTagWrite(t().tagDeleted, t().tagDeletedReloadFailed);
    } finally {
      deleteTagConfirming = false;
    }
  };

  const requestControllers = new Set<AbortController>();
  const runRequest = async <T,>(request: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (disposed) throw new DOMException(t().settingsClosedAbort, "AbortError");
    if (settingsBusy()) throw new Error(t().settingsChangeInProgress);
    const controller = new AbortController();
    requestControllers.add(controller);
    setOwnerRequestCount((count) => count + 1);
    try {
      const result = await request(controller.signal);
      if (disposed) throw new DOMException(t().settingsClosedAbort, "AbortError");
      return result;
    } finally {
      requestControllers.delete(controller);
      if (!disposed) setOwnerRequestCount((count) => Math.max(0, count - 1));
    }
  };

  const grantAccess = async (input: { bookId: string; principal: Principal; permission: GrantableLevel }): Promise<AccessEntry> => {
    const created = await runRequest(async (abortSignal) => {
      const response = await apiClient.books[":bookId"].access.$post(
        { param: { bookId: input.bookId }, json: { principal: input.principal, permission: input.permission } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().grantAccessFailed));
      return response.json();
    });
    props.onWorkspaceChange();
    reconcile(t().accessGrantedReloadFailed);
    return created;
  };
  const updateAccess = async (input: { bookId: string; accessId: string; permission: GrantableLevel }): Promise<void> => {
    await runRequest(async (abortSignal) => {
      const response = await apiClient.books[":bookId"].access[":accessId"].$patch(
        { param: { bookId: input.bookId, accessId: input.accessId }, json: { permission: input.permission } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().updateAccessFailed));
    });
    props.onWorkspaceChange();
    reconcile(t().accessUpdatedReloadFailed);
  };
  const revokeAccess = async (input: { bookId: string; accessId: string }): Promise<void> => {
    await runRequest(async (abortSignal) => {
      const response = await apiClient.books[":bookId"].access[":accessId"].$delete(
        { param: { bookId: input.bookId, accessId: input.accessId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().revokeAccessFailed));
    });
    props.onWorkspaceChange();
    reconcile(t().accessRevokedReloadFailed);
  };

  type CreateApiKeyInput = { name: string; expiresAt: string | null; permission: GrantableLevel };
  const createApiKey = async (input: {
    bookId: string;
    value: CreateApiKeyInput;
  }): Promise<{ credential: ResourceApiKey; token: string }> => {
    const created = await runRequest(async (abortSignal) => {
      const response = await apiClient.books[":bookId"]["api-keys"].$post(
        { param: { bookId: input.bookId }, json: input.value },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().createApiKeyFailed));
      return response.json();
    });
    props.onWorkspaceChange();
    reconcile(t().apiKeyCreatedReloadFailed);
    return created;
  };
  const revokeApiKey = async (input: { bookId: string; credentialId: string }): Promise<void> => {
    await runRequest(async (abortSignal) => {
      const response = await apiClient.books[":bookId"]["api-keys"][":credentialId"].$delete(
        { param: { bookId: input.bookId, credentialId: input.credentialId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readErrorMessage(response, t().revokeApiKeyFailed));
    });
    props.onWorkspaceChange();
    reconcile(t().apiKeyRevokedReloadFailed);
  };

  onCleanup(() => {
    disposed = true;
    updateMutation.abort();
    createTagMutation.abort();
    updateTagMutation.abort();
    deleteTagMutation.abort();
    for (const controller of requestControllers) controller.abort();
    requestControllers.clear();
    tagCoverage.dispose();
    settingsCoverage.dispose();
  });

  const settingsActivityBlocked = () =>
    settingsInteractionBlocked({
      writePending: updateMutation.loading() || ownerRequestCount() > 0 || tagOperationPending() || deleteTagConfirming,
      childWritePending: deleteBookPending(),
      coveragePending: settingsReconciling(),
      coverageError: reconcileError() !== null,
    });
  const settingsBusy = () => navigationPromptPending || settingsActivityBlocked();

  const requestTabChange = async (nextTab: string) => {
    if (nextTab === activeTab()) return;
    if (settingsBusy()) return;
    navigationPromptPending = true;
    try {
      if (!(await confirmDiscardIfDirty(tagEditorDirty))) return;
      if (disposed || settingsActivityBlocked()) return;
      setActiveTab(nextTab);
    } finally {
      navigationPromptPending = false;
    }
  };

  const requestClose = async () => {
    if (settingsBusy()) return;
    navigationPromptPending = true;
    try {
      if (!(await confirmDiscardIfDirty(() => changeCount() > 0 || tagEditorDirty()))) return;
      if (disposed || settingsActivityBlocked()) return;
      props.onClose();
    } finally {
      navigationPromptPending = false;
    }
  };

  return (
    <SettingsModal
      title={t().settingsTitle}
      activeTab={activeTab()}
      onTabChange={(tab) => void requestTabChange(tab)}
      onClose={() => void requestClose()}
      closeLabel={t().closeSettings}
    >
      <Show when={reconcileError()}>
        <div class="mx-4 mt-3 flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-300" role="status">
          <span>{reconcileError()}</span>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={() => void settingsCoverage.retry()}
            disabled={settingsReconciling()}
          >
            {t().retryReload}
          </Button>
        </div>
      </Show>
      <SettingsModal.Group title={t().groupBook}>
        <SettingsModal.Tab id="general" title={t().tabGeneral} icon="ti ti-id" description={t().tabGeneralDescription}>
          <SettingsGroup title={t().identityTitle} description={t().identityDescription}>
            <SettingsField
              label={t().bookNameLabel}
              description={t().bookNameDescription}
              error={nameError}
              changed={nameChanged}
            >
              <TextInput
                aria-label={t().bookNameLabel}
                placeholder={t().bookNamePlaceholder}
                required
                value={name}
                onValueChange={setName}
                onSubmit={saveMetadata}
              />
            </SettingsField>
            <SettingsField
              label={t().descriptionLabel}
              description={t().descriptionDescription}
              error={() => undefined}
              changed={descriptionChanged}
            >
              <TextInput
                aria-label={t().descriptionLabel}
                multiline
                lines={3}
                placeholder={t().descriptionPlaceholder}
                value={description}
                onValueChange={setDescription}
                onSubmit={saveMetadata}
              />
            </SettingsField>
          </SettingsGroup>
          <SettingsModal.Footer>
            <SettingsPanelFooter
              changeCount={changeCount}
              loading={updateMutation.loading}
              onDiscard={discardMetadata}
              onSave={saveMetadata}
            />
          </SettingsModal.Footer>
        </SettingsModal.Tab>

        <SettingsModal.Tab id="tags" title={t().tabTags} icon="ti ti-tags" description={t().tabTagsDescription}>
          <SettingsGroup title={t().vocabularyTitle} description={t().vocabularyDescription}>
            <Show when={tagReconciling()}>
              <p class="text-xs text-dimmed" role="status">
                {t().reloadingTags}
              </p>
            </Show>
            <Show when={tagReconcileError()}>
              <div class="flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-300" role="status">
                <span>{tagReconcileError()}</span>
                <Button type="button" variant="secondary" size="xs" onClick={() => void tagCoverage.retry()} disabled={tagReconciling()}>
                  {t().retryReload}
                </Button>
              </div>
            </Show>
            <TagEditor
              items={props.context().tags}
              onCreate={createTag}
              onUpdate={updateTag}
              onDelete={deleteTag}
              onDirtyChange={setTagEditorDirty}
              disabled={coverageBlocked() || tagReconciling() || tagReconcileError() !== null}
            />
          </SettingsGroup>
        </SettingsModal.Tab>
      </SettingsModal.Group>

      <SettingsModal.Group title={t().groupSharing}>
        <SettingsModal.Tab id="access" title={t().tabAccess} icon="ti ti-shield" description={t().tabAccessDescription}>
          <SettingsGroup title={t().peopleGroupsTitle} description={t().peopleGroupsDescription}>
            <Show when={props.context().accessEntries} keyed>
              {(accessEntries) => (
                <PermissionEditor
                  initialEntries={accessEntries.filter((entry) => entry.principal.type !== "service_account")}
                  canEdit={!coverageBlocked()}
                  grantAccess={async (principal, permission) => {
                    return grantAccess({ bookId: bookId(), principal, permission });
                  }}
                  updateAccess={async (accessId, permission) => {
                    await updateAccess({ bookId: bookId(), accessId, permission });
                  }}
                  revokeAccess={async (accessId) => {
                    await revokeAccess({ bookId: bookId(), accessId });
                  }}
                />
              )}
            </Show>
          </SettingsGroup>
        </SettingsModal.Tab>

        <SettingsModal.Tab id="api-keys" title={t().tabApiKeys} icon="ti ti-key" description={t().tabApiKeysDescription}>
          <Show when={props.context().apiKeys} keyed>
            {(apiKeys) => (
              <fieldset disabled={coverageBlocked()}>
                <ResourceApiKeys
                  title={t().integrationAccessTitle}
                  description={t().integrationAccessDescription}
                  initialKeys={apiKeys}
                  createKey={async (input) => {
                    return createApiKey({ bookId: bookId(), value: { ...input } });
                  }}
                  revokeKey={async (credentialId) => {
                    await revokeApiKey({ bookId: bookId(), credentialId });
                  }}
                />
              </fieldset>
            )}
          </Show>
        </SettingsModal.Tab>
      </SettingsModal.Group>

      <SettingsModal.Group title={t().groupData}>
        <SettingsModal.Tab id="transfer" title={t().tabTransfer} icon="ti ti-arrows-exchange" description={t().tabTransferDescription}>
          <SettingsGroup title={t().contactDataTitle} description={t().contactDataDescription}>
            <BookActions bookId={bookId()} canWrite={!coverageBlocked()} onImported={props.onWorkspaceChange} />
          </SettingsGroup>
        </SettingsModal.Tab>
      </SettingsModal.Group>

      <SettingsModal.Group title={t().groupLifecycle}>
        <SettingsModal.Tab
          id="danger"
          title={t().tabDanger}
          icon="ti ti-alert-triangle"
          description={t().tabDangerDescription}
          tone="danger"
        >
          <SettingsGroup title={t().deleteBookTitle} description={t().deleteBookGroupDescription}>
            <SettingsGroup.Action>
              <DeleteBookButton
                bookId={bookId()}
                bookName={name().trim() || savedName()}
                onDeleted={props.onDeleted}
                onPendingChange={setDeleteBookPending}
                disabled={coverageBlocked()}
              />
            </SettingsGroup.Action>
          </SettingsGroup>
        </SettingsModal.Tab>
      </SettingsModal.Group>
    </SettingsModal>
  );
}
