import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  confirmDiscardIfDirty,
  Dropdown,
  dialogCore,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  Select,
  StatusBadge,
  Switch,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { ConfigurableFolderRole, MailCommand } from "../../contracts";
import type { MailAdminFolderView } from "../../service/folders";
import { readApiError } from "./api-response";
import { buildMailFolderTree, flattenMailFolderTree } from "./mail-folder-tree";
import { mailSettingsMessages } from "./mail-settings-messages";

type FolderSelectOption = {
  id: string;
  label: string;
  description: string;
  icon: string;
};

const TOP_LEVEL_FOLDER_ID = "__top_level__";
const terminalCommandStates = new Set(["confirmed", "reconciled", "failed", "cancelled", "ambiguous", "needs_attention"]);
const folderEditorDialogOptions = {
  ...panelDialogOptions,
  cancelBehavior: "ignore" as const,
};

const filterFolderOptions = (options: FolderSelectOption[], query: string, signal: AbortSignal): FolderSelectOption[] => {
  if (signal.aborted) return [];
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return options;
  return options.filter((option) => `${option.label} ${option.description}`.toLocaleLowerCase().includes(normalized));
};

const wait = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });

type Messages = ReturnType<typeof mailSettingsMessages.resolve>["t"];

const waitForFolderCommand = async (
  mailboxId: string,
  command: MailCommand,
  signal: AbortSignal,
  messages: Messages,
): Promise<MailCommand> => {
  let current = command;
  for (let attempt = 0; attempt < 90 && !terminalCommandStates.has(current.state); attempt += 1) {
    await wait(Math.min(1_000, 200 + attempt * 50), signal);
    const response = await apiClient.mailboxes[":mailboxId"].commands[":commandId"].$get(
      { param: { mailboxId, commandId: command.id } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, messages.failedVerifyFolderOperation));
    current = await response.json();
  }
  if (!terminalCommandStates.has(current.state)) {
    throw new Error(messages.folderOperationPending);
  }
  if (current.state !== "confirmed" && current.state !== "reconciled") {
    throw new Error(current.lastError || messages.folderOperationFailed);
  }
  return current;
};

const runFolderCommand = async (
  mailboxId: string,
  input:
    | { kind: "create_folder"; parentFolderId: string | null; name: string; subscribe: boolean; showInSidebar: boolean }
    | { kind: "rename_folder"; folderId: string; name: string }
    | { kind: "delete_folder"; folderId: string }
    | { kind: "set_folder_subscription"; folderId: string; subscribed: boolean },
  signal: AbortSignal,
  idempotencyKey: string,
  messages: Messages,
): Promise<MailCommand> => {
  const response = await apiClient.mailboxes[":mailboxId"].commands.$post(
    {
      param: { mailboxId },
      json: { ...input, idempotencyKey },
    },
    { init: { signal } },
  );
  if (!response.ok) throw new Error(await readApiError(response, messages.failedStartFolderOperation));
  return waitForFolderCommand(mailboxId, await response.json(), signal, messages);
};

function FolderEditor(props: {
  mailboxId: string;
  folders: MailAdminFolderView[];
  parentFolderId: string | null;
  folder: MailAdminFolderView | null;
  close: () => void;
  onSaved: () => Promise<void>;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const create = () => props.folder === null;
  const [name, setName] = createSignal(props.folder?.name ?? "");
  const [parentFolderId, setParentFolderId] = createSignal(props.parentFolderId);
  const [showInSidebar, setShowInSidebar] = createSignal(true);
  const [subscribe, setSubscribe] = createSignal(true);
  const [reconciling, setReconciling] = createSignal(false);
  const dirty = () =>
    name() !== (props.folder?.name ?? "") || (create() && (parentFolderId() !== props.parentFolderId || !showInSidebar() || !subscribe()));
  const closeSafely = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  const parentOptions = createMemo<FolderSelectOption[]>(() => [
    {
      id: TOP_LEVEL_FOLDER_ID,
      label: messages().topLevel,
      description: messages().topLevelDescription,
      icon: "ti ti-folders",
    },
    ...flattenMailFolderTree(buildMailFolderTree(props.folders))
      .filter(({ folder }) => folder.canCreateChildren)
      .map(({ folder, depth }) => ({
        id: folder.id,
        label: `${"- ".repeat(depth)}${folder.name}`,
        description: `${folder.namespaceKinds.includes("shared") ? messages().sharedFolder : messages().mailboxFolder}${
          folder.showInSidebar ? "" : ` · ${messages().hiddenInSidebar}`
        }`,
        icon: folder.namespaceKinds.includes("shared") ? "ti ti-users" : "ti ti-folder",
      })),
  ]);
  const selectedParentLabel = () => parentOptions().find((option) => option.id === (parentFolderId() ?? TOP_LEVEL_FOLDER_ID))?.label;
  const fetchParentOptions = async (query: string, signal: AbortSignal): Promise<FolderSelectOption[]> =>
    filterFolderOptions(parentOptions(), query, signal);
  const save = mutation.create<void, void, { idempotencyKey: string }>({
    onBefore: () => ({ idempotencyKey: crypto.randomUUID() }),
    mutation: async (_input, context) => {
      if (create()) {
        await runFolderCommand(
          props.mailboxId,
          {
            kind: "create_folder",
            parentFolderId: parentFolderId() || null,
            name: name().trim(),
            subscribe: subscribe(),
            showInSidebar: showInSidebar(),
          },
          context.abortSignal,
          context.idempotencyKey,
          messages(),
        );
      } else {
        await runFolderCommand(
          props.mailboxId,
          { kind: "rename_folder", folderId: props.folder!.id, name: name().trim() },
          context.abortSignal,
          context.idempotencyKey,
          messages(),
        );
      }
    },
    onSuccess: () => {
      setReconciling(true);
      void props
        .onSaved()
        .then(() => {
          toast.success(create() ? messages().folderCreated : messages().folderRenamed);
          props.close();
        })
        .catch((error) =>
          prompts.error(error instanceof Error ? error.message : messages().folderListRefreshFailed, {
            title: create() ? messages().folderCreatedRefreshFailed : messages().folderRenamedRefreshFailed,
          }),
        )
        .finally(() => setReconciling(false));
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => save.abort());

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={create() ? messages().newFolder : messages().renameFolder}
        subtitle={create() ? messages().createFolderSubtitle : messages().renameFolderSubtitle}
        icon={create() ? "ti ti-folder-plus" : "ti ti-edit"}
        close={() => void closeSafely()}
      />
      <PanelDialog.Body>
        <div class="flex flex-col gap-2">
          <TextInput label={messages().name} value={name} onValueChange={setName} required />
          <Show when={create()}>
            <Select
              label={messages().location}
              description={messages().locationDescription}
              value={() => parentFolderId() ?? TOP_LEVEL_FOLDER_ID}
              selectedLabel={selectedParentLabel}
              fetchData={fetchParentOptions}
              fetchDebounceMs={0}
              placeholder={messages().searchFolders}
              icon="ti ti-folder"
              activeIcon="ti ti-search"
              onValueChange={(value) => setParentFolderId(value === TOP_LEVEL_FOLDER_ID ? null : value)}
            />
            <div class="flex flex-col gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] px-3 py-3">
              <Switch label={messages().showInMailboxNavigation} value={showInSidebar} onValueChange={setShowInSidebar} />
              <Switch label={messages().subscribeOnProvider} value={subscribe} onValueChange={setSubscribe} />
            </div>
          </Show>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="ghost" size="sm" type="button" onClick={() => void closeSafely()}>
          {messages().cancel}
        </Button>
        <Button size="sm" type="button" disabled={save.loading() || reconciling() || !name().trim()} onClick={() => save.mutate()}>
          <i
            class={`ti ${save.loading() || reconciling() ? "ti-loader-2 animate-spin" : create() ? "ti-folder-plus" : "ti-device-floppy"}`}
            aria-hidden="true"
          />
          {create() ? messages().createFolder : messages().saveName}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default function MailFolderSettings(props: {
  mailboxId: string;
  folders: MailAdminFolderView[];
  reloading: boolean;
  onReload: () => Promise<void>;
  onWorkspaceChange: () => void;
  onFolderVisibilityChange: (folderId: string, showInSidebar: boolean) => void;
  onFolderRoleChange: (role: ConfigurableFolderRole, folderId: string) => void;
  folderRolePending: boolean;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const folderRoles = createMemo<Array<{ id: ConfigurableFolderRole; label: string; icon: string }>>(() => [
    { id: "sent", label: messages().sent, icon: "ti ti-send" },
    { id: "drafts", label: messages().drafts, icon: "ti ti-file-pencil" },
    { id: "archive", label: messages().archive, icon: "ti ti-archive" },
    { id: "trash", label: messages().trash, icon: "ti ti-trash" },
    { id: "junk", label: messages().junk, icon: "ti ti-alert-octagon" },
  ]);
  const [pendingFolderId, setPendingFolderId] = createSignal<string | null>(null);
  const rows = createMemo(() => flattenMailFolderTree(buildMailFolderTree(props.folders)));
  const roleFolderOptions = createMemo<FolderSelectOption[]>(() =>
    props.folders
      .filter((folder) => folder.selectable && folder.discoveryState === "active")
      .map((folder) => ({
        id: folder.id,
        label: folder.name,
        description: folder.namespaceKinds.includes("shared") ? messages().sharedFolder : messages().mailboxFolder,
        icon: "ti ti-folder",
      })),
  );
  const fetchRoleFolderOptions = async (query: string, signal: AbortSignal): Promise<FolderSelectOption[]> =>
    filterFolderOptions(roleFolderOptions(), query, signal);
  const refresh = async () => {
    await props.onReload();
    props.onWorkspaceChange();
  };
  const openFolderEditor = (folder: MailAdminFolderView | null, parentFolderId: string | null = null) =>
    dialogCore.open<void>(
      (close) => (
        <FolderEditor
          mailboxId={props.mailboxId}
          folders={props.folders}
          folder={folder}
          parentFolderId={parentFolderId}
          close={() => close()}
          onSaved={refresh}
        />
      ),
      folderEditorDialogOptions,
    );

  const updateVisibility = mutation.create<{ folderId: string; showInSidebar: boolean }, { folderId: string; showInSidebar: boolean }>({
    mutation: async (input, { abortSignal }) => {
      setPendingFolderId(input.folderId);
      try {
        const response = await apiClient.mailboxes[":mailboxId"].folders[":folderId"].$patch(
          {
            param: { mailboxId: props.mailboxId, folderId: input.folderId },
            json: { showInSidebar: input.showInSidebar },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, messages().failedUpdateFolderVisibility));
        return response.json();
      } finally {
        setPendingFolderId(null);
      }
    },
    onSuccess: ({ folderId, showInSidebar }) => {
      props.onFolderVisibilityChange(folderId, showInSidebar);
      props.onWorkspaceChange();
    },
    onError: (error) => prompts.error(error.message),
  });

  const folderMutation = mutation.create<
    { changed: boolean; action: "subscription" | "delete" | "dismiss" },
    { folder: MailAdminFolderView; action: "subscription" | "delete" | "dismiss" },
    { idempotencyKey: string }
  >({
    onBefore: () => ({ idempotencyKey: crypto.randomUUID() }),
    mutation: async ({ folder, action }, context) => {
      setPendingFolderId(folder.id);
      try {
        if (action === "subscription") {
          await runFolderCommand(
            props.mailboxId,
            { kind: "set_folder_subscription", folderId: folder.id, subscribed: folder.subscribed !== true },
            context.abortSignal,
            context.idempotencyKey,
            messages(),
          );
          return { changed: true, action };
        }
        if (action === "dismiss") {
          const confirmed = await prompts.confirm(messages().removeUnavailableFolderDescription, {
            title: messages().removeFolderFromMail({ name: folder.name }),
            confirmText: messages().removeFromMail,
            variant: "danger",
          });
          if (!confirmed || context.abortSignal.aborted) return { changed: false, action };
          const response = await apiClient.mailboxes[":mailboxId"].folders[":folderId"].$delete(
            {
              param: { mailboxId: props.mailboxId, folderId: folder.id },
            },
            { init: { signal: context.abortSignal } },
          );
          if (!response.ok) throw new Error(await readApiError(response, messages().failedRemoveUnavailableFolder));
          return { changed: true, action };
        }
        const confirmed = await prompts.confirm(messages().deleteProviderFolderDescription, {
          title: messages().deleteNamedFolder({ name: folder.name }),
          confirmText: messages().deleteFolder,
          variant: "danger",
        });
        if (!confirmed || context.abortSignal.aborted) return { changed: false, action };
        await runFolderCommand(
          props.mailboxId,
          { kind: "delete_folder", folderId: folder.id },
          context.abortSignal,
          context.idempotencyKey,
          messages(),
        );
        return { changed: true, action };
      } finally {
        setPendingFolderId(null);
      }
    },
    onSuccess: ({ changed, action }) => {
      if (!changed) return;
      void refresh()
        .then(() =>
          toast.success(
            action === "delete"
              ? messages().folderDeleted
              : action === "dismiss"
                ? messages().unavailableFolderRemoved
                : messages().providerSubscriptionUpdated,
          ),
        )
        .catch((error) =>
          prompts.error(error instanceof Error ? error.message : messages().foldersRefreshFailed, {
            title: messages().folderUpdatedRefreshFailed,
          }),
        );
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => {
    updateVisibility.abort();
    folderMutation.abort();
  });

  const busy = () => props.reloading || pendingFolderId() !== null;

  return (
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between gap-3">
        <p class="text-xs text-dimmed">{messages().folderVisibilityDescription}</p>
        <Button variant="secondary" size="sm" type="button" class="shrink-0" disabled={busy()} onClick={() => void openFolderEditor(null)}>
          <i class="ti ti-folder-plus" aria-hidden="true" />
          {messages().newFolder}
        </Button>
      </div>

      <details class="group rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)]">
        <summary class="focus-ui flex cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--ui-radius-control)] px-3 py-2.5 text-sm font-medium text-primary">
          <span class="flex min-w-0 items-center gap-2">
            <i class="ti ti-folders text-secondary" aria-hidden="true" />
            {messages().specialFolderMappings}
          </span>
          <i class="ti ti-chevron-down text-secondary transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div class="flex flex-col gap-2 px-3 pb-3">
          <p class="text-xs text-dimmed">{messages().specialFolderMappingsDescription}</p>
          <For each={folderRoles()}>
            {(role) => {
              const current = () => props.folders.find((folder) => folder.configuredRole === role.id || folder.role === role.id);
              return (
                <Select
                  label={role.label}
                  description={messages().folderRoleDescription({ role: role.label })}
                  icon={role.icon}
                  value={() => current()?.id ?? null}
                  selectedLabel={() => current()?.name}
                  fetchData={fetchRoleFolderOptions}
                  fetchDebounceMs={0}
                  placeholder={messages().searchRoleFolders({ role: role.label })}
                  activeIcon="ti ti-search"
                  clearable
                  disabled={props.folderRolePending || busy()}
                  onValueChange={(folderId) => props.onFolderRoleChange(role.id, folderId ?? "")}
                />
              );
            }}
          </For>
        </div>
      </details>

      <div class="flex flex-col gap-0.5">
        <Show
          when={rows().length > 0}
          fallback={
            <Placeholder
              icon="ti ti-folder-off"
              title={messages().noFoldersDiscovered}
              description={messages().noFoldersDiscoveredDescription}
            />
          }
        >
          <For each={rows()}>
            {({ folder, depth, hiddenByParent }) => {
              const shared = () => folder.namespaceKinds.some((kind) => kind === "shared" || kind === "other_users");
              const canManageSidebarVisibility = () => folder.selectable || folder.subscribed !== false;
              const menuItems = () => [
                ...(folder.canCreateChildren
                  ? [{ label: messages().newSubfolder, icon: "ti ti-folder-plus", action: () => void openFolderEditor(null, folder.id) }]
                  : []),
                ...(folder.canRename
                  ? [{ label: messages().rename, icon: "ti ti-edit", action: () => void openFolderEditor(folder) }]
                  : []),
                ...(folder.canManageSubscription
                  ? [
                      {
                        label: folder.subscribed ? messages().unsubscribeOnProvider : messages().subscribeOnProvider,
                        icon: folder.subscribed ? "ti ti-bookmark-off" : "ti ti-bookmark",
                        action: () => folderMutation.mutate({ folder, action: "subscription" }),
                      },
                    ]
                  : []),
                ...(folder.discoveryState === "active" && canManageSidebarVisibility()
                  ? [
                      {
                        label: folder.showInSidebar ? messages().hideFromMail : messages().showInMail,
                        icon: folder.showInSidebar ? "ti ti-eye-off" : "ti ti-eye",
                        action: () => updateVisibility.mutate({ folderId: folder.id, showInSidebar: !folder.showInSidebar }),
                      },
                    ]
                  : []),
                ...(folder.discoveryState === "missing"
                  ? [
                      {
                        label: messages().removeFromMail,
                        icon: "ti ti-folder-off",
                        variant: "danger" as const,
                        action: () => folderMutation.mutate({ folder, action: "dismiss" }),
                      },
                    ]
                  : []),
                ...(folder.canDelete
                  ? [
                      {
                        label: messages().deleteFolder,
                        icon: "ti ti-trash",
                        variant: "danger" as const,
                        action: () => folderMutation.mutate({ folder, action: "delete" }),
                      },
                    ]
                  : []),
              ];
              const status = () => {
                if (folder.discoveryState === "missing") {
                  return { label: messages().unavailable, icon: "ti ti-folder-off", tone: "warning" as const };
                }
                if (folder.discoveryState === "ambiguous") {
                  return { label: messages().needsReview, icon: "ti ti-alert-triangle", tone: "warning" as const };
                }
                if (!canManageSidebarVisibility()) return null;
                if (!folder.showInSidebar) return { label: messages().hidden, icon: "ti ti-eye-off", tone: "neutral" as const };
                if (hiddenByParent) return { label: messages().parentHidden, icon: "ti ti-eye-off", tone: "neutral" as const };
                return { label: messages().visible, icon: "ti ti-eye", tone: "neutral" as const };
              };
              return (
                <div class="group flex min-h-10 items-center gap-2 rounded-[var(--ui-radius-control)] px-2 py-1.5 hover:bg-[var(--ui-hover)]">
                  <span class="flex min-w-0 flex-1 items-center gap-2" style={{ "padding-left": `${depth * 16}px` }}>
                    <i class={`ti ${folder.selectable ? "ti-folder" : "ti-folders"} shrink-0 text-secondary`} aria-hidden="true" />
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-medium text-primary">{folder.name}</span>
                      <span class="flex flex-wrap items-center gap-1 text-xs text-dimmed">
                        <Show when={shared()}>
                          <span>{messages().sharedByProvider}</span>
                        </Show>
                        <Show when={folder.discoveryState !== "active"}>
                          <span>{folder.discoveryState === "missing" ? messages().unavailable : messages().needsReview}</span>
                        </Show>
                        <Show when={folder.subscribed === false}>
                          <span>{messages().notSubscribed}</span>
                        </Show>
                        <Show when={!folder.selectable}>
                          <span>{messages().folderGroup}</span>
                        </Show>
                      </span>
                    </span>
                  </span>
                  <Show when={status()}>
                    {(currentStatus) => (
                      <StatusBadge class="shrink-0" tone={currentStatus().tone} icon={currentStatus().icon} label={currentStatus().label} />
                    )}
                  </Show>
                  <Show when={menuItems().length > 0}>
                    <Dropdown.Root position="bottom-left" items={menuItems()}>
                      <Dropdown.Trigger
                        iconOnly
                        type="button"
                        variant="ghost"
                        disabled={busy()}
                        label={messages().folderActions({ name: folder.name })}
                      >
                        <i
                          class={busy() && pendingFolderId() === folder.id ? "ti ti-loader-2 animate-spin" : "ti ti-dots"}
                          aria-hidden="true"
                        />
                      </Dropdown.Trigger>
                    </Dropdown.Root>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}
