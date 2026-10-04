import { mutation } from "@k2b/stdlib/solid";
import {
  announce,
  Button,
  confirmDiscardIfDirty,
  Dropdown,
  type DropdownAction,
  type DropdownSection,
  dialogCore,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  Select,
  Switch,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { ConfigurableFolderRole, FolderDisplay, MailCommand } from "../../contracts";
import { isStricterDisplay } from "../../folder-display-rules";
import { buildMailFolderTree, mailFolderPaths } from "../../folder-tree";
import type { MailAdminFolderView } from "../../service/folders";
import { readApiError } from "./api-response";
import { mailFolderDisplayStates, mailFolderDisplayToStore, mailFolderSettingsRows } from "./mail-folder-settings-model";
import { flattenMailFolderTree } from "./mail-folder-tree";
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
  const parentOptions = createMemo<FolderSelectOption[]>(() => {
    const paths = mailFolderPaths(props.folders);
    return [
      {
        id: TOP_LEVEL_FOLDER_ID,
        label: messages().topLevel,
        description: messages().topLevelDescription,
        icon: "ti ti-folders",
      },
      ...flattenMailFolderTree(buildMailFolderTree(props.folders))
        .filter(({ folder }) => folder.canCreateChildren)
        .map(({ folder }) => ({
          id: folder.id,
          label: paths.get(folder.id) ?? folder.name,
          description: `${folder.namespaceKinds.includes("shared") ? messages().sharedFolder : messages().mailboxFolder}${
            folder.display === "hidden" ? ` · ${messages().hiddenInSidebar}` : ""
          }`,
          icon: folder.namespaceKinds.includes("shared") ? "ti ti-users" : "ti ti-folder",
        })),
    ];
  });
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
              <Switch
                label={messages().showInMail}
                description={messages().showInMailDescription}
                value={showInSidebar}
                onValueChange={setShowInSidebar}
              />
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

const DISPLAYS: readonly FolderDisplay[] = ["everywhere", "folder_only", "hidden"];
const DISPLAY_ICONS: Record<FolderDisplay, string> = {
  everywhere: "ti ti-eye",
  folder_only: "ti ti-folder-pin",
  hidden: "ti ti-eye-off",
};
const ROLE_ICONS: Record<string, string> = {
  inbox: "ti ti-inbox",
  sent: "ti ti-send",
  drafts: "ti ti-file-pencil",
  archive: "ti ti-archive",
  trash: "ti ti-trash",
  junk: "ti ti-alert-octagon",
  all: "ti ti-mail",
};

const folderIcon = (folder: MailAdminFolderView): string => {
  if (folder.discoveryState === "missing") return "ti ti-folder-off";
  if (!folder.selectable) return "ti ti-folders";
  // Provider collections such as Gmail's Important hold copies; their stack icon tells them from filed folders.
  return ROLE_ICONS[folder.role] ?? (folder.displayNeutral ? "ti ti-stack-2" : "ti ti-folder");
};

type FolderState = {
  kind: "default" | "own" | "inherited" | "warning";
  icon: string;
  long: string;
  short: string;
  /** The full state for the row's name, where `long` or `short` alone is not enough. */
  spoken: string;
};

export default function MailFolderSettings(props: {
  mailboxId: string;
  folders: MailAdminFolderView[];
  reloading: boolean;
  onReload: () => Promise<void>;
  onWorkspaceChange: () => void;
  onFolderVisibilityChange: (folderId: string, display: FolderDisplay) => void;
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
  const [collapsedIds, setCollapsedIds] = createSignal<ReadonlySet<string>>(new Set());
  const rows = createMemo(() => mailFolderSettingsRows(props.folders, collapsedIds()));
  // Rows are keyed by folder ID, so a reload or a display change keeps each row, its open menu, and its focus.
  const rowIds = createMemo(() => rows().map((row) => row.folder.id));
  const rowById = createMemo(() => new Map(rows().map((row) => [row.folder.id, row])));
  const folderById = createMemo(() => new Map(props.folders.map((folder) => [folder.id, folder])));
  const displayStates = createMemo(() => mailFolderDisplayStates(props.folders));
  const displayLabel = (display: FolderDisplay) =>
    display === "everywhere" ? messages().everywhere : display === "folder_only" ? messages().onlyInFolder : messages().hidden;
  const toggleCollapsed = (folderId: string) =>
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (!next.delete(folderId)) next.add(folderId);
      return next;
    });
  const roleFolderOptions = createMemo<FolderSelectOption[]>(() => {
    const paths = mailFolderPaths(props.folders);
    return props.folders
      .filter((folder) => folder.selectable && folder.discoveryState === "active")
      .map((folder) => ({
        id: folder.id,
        label: paths.get(folder.id) ?? folder.name,
        description: folder.namespaceKinds.includes("shared") ? messages().sharedFolder : messages().mailboxFolder,
        icon: "ti ti-folder",
      }));
  });
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

  const updateDisplay = mutation.create<
    { folder: MailAdminFolderView; display: FolderDisplay; chosen: FolderDisplay; subfolders: number },
    { folder: MailAdminFolderView; display: FolderDisplay; chosen: FolderDisplay; subfolders: number }
  >({
    mutation: async (input, { abortSignal }) => {
      setPendingFolderId(input.folder.id);
      try {
        const response = await apiClient.mailboxes[":mailboxId"].folders[":folderId"].$patch(
          {
            param: { mailboxId: props.mailboxId, folderId: input.folder.id },
            json: { display: input.display },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, messages().failedUpdateFolderVisibility));
        await response.json();
        return input;
      } finally {
        setPendingFolderId(null);
      }
    },
    onSuccess: ({ folder, display, chosen, subfolders }) => {
      props.onFolderVisibilityChange(folder.id, display);
      announce(messages().folderDisplayChanged({ name: folder.name, display: displayLabel(chosen), subfolders }));
      // Reload, so the sidebar and the workspace counts follow the new display.
      void refresh();
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
    updateDisplay.abort();
    folderMutation.abort();
  });

  const busy = () => props.reloading || pendingFolderId() !== null;
  // While one change runs, the menus offer no second one. The rows stay enabled, so the row that opened the menu keeps
  // its focus and nothing dims while the change saves and the folders reload.
  const changing = () => pendingFolderId() !== null;
  const childIds = createMemo(() => {
    const children = new Map<string | null, string[]>();
    for (const row of rows()) {
      const siblings = children.get(row.parentRowId);
      if (siblings) siblings.push(row.folder.id);
      else children.set(row.parentRowId, [row.folder.id]);
    }
    return children;
  });

  // Each folder is a list item, and its subfolders are a list inside it, so assistive technology knows the hierarchy.
  const folderList = (parentId: string | null) => <For each={childIds().get(parentId) ?? []}>{(folderId) => folderRow(folderId)}</For>;

  const folderRow = (folderId: string) => {
    const row = () => rowById().get(folderId)!;
    const folder = () => row().folder;
    const state = () => displayStates().get(folderId)!;
    const nameOf = (id: string | null | undefined) => (id ? (folderById().get(id)?.name ?? "") : "");
    const shared = () => folder().namespaceKinds.some((kind) => kind === "shared" || kind === "other_users");
    const canChooseDisplay = () => folder().discoveryState === "active" && (folder().selectable || folder().subscribed !== false);
    const status = (): FolderState => {
      if (folder().discoveryState !== "active") {
        const label = folder().discoveryState === "missing" ? messages().unavailable : messages().needsReview;
        const icon = folder().discoveryState === "missing" ? "ti ti-folder-off" : "ti ti-alert-triangle";
        return { kind: "warning", icon, long: label, short: label, spoken: label };
      }
      const display = state().effectiveDisplay;
      const label = displayLabel(display);
      const source = nameOf(state().inheritedFromFolderId);
      if (state().inheritedFromFolderId) {
        return {
          kind: "inherited",
          icon: DISPLAY_ICONS[display],
          long: messages().inheritedFrom({ name: source }),
          short: messages().inherited,
          spoken: messages().inheritedDisplay({ display: label, name: source }),
        };
      }
      return {
        kind: display === "everywhere" ? "default" : "own",
        icon: DISPLAY_ICONS[display],
        long: label,
        short: label,
        spoken: label,
      };
    };
    const choiceDescription = (display: FolderDisplay): { text: string; disabled: boolean } => {
      const floor = state().floor;
      if (floor && isStricterDisplay(floor.display, display)) {
        return { text: messages().displaySetBy({ name: nameOf(floor.folderId) }), disabled: true };
      }
      const neutral = folder().displayNeutral;
      if (neutral && display === "folder_only") return { text: messages().onlyInFolderNeutralDescription, disabled: true };
      const text =
        display === "everywhere"
          ? neutral
            ? messages().everywhereNeutralDescription
            : messages().everywhereDescription
          : display === "folder_only"
            ? messages().onlyInFolderDescription
            : neutral
              ? messages().hiddenNeutralDescription
              : messages().hiddenDescription;
      // The choice that follows the parent names it, so a keyboard or screen reader user also learns why the looser
      // choices, which a menu skips, are not available.
      return {
        text: floor && display === floor.display ? `${text} ${messages().followsParent({ name: nameOf(floor.folderId) })}` : text,
        disabled: false,
      };
    };
    const chooseDisplay = (chosen: FolderDisplay) => {
      if (changing()) return;
      const display = mailFolderDisplayToStore(chosen, state());
      if (display === folder().display) return;
      updateDisplay.mutate({ folder: folder(), display, chosen, subfolders: row().descendantCount });
    };
    const actions = (): DropdownAction[] => [
      ...(folder().canCreateChildren
        ? [{ label: messages().newSubfolder, icon: "ti ti-folder-plus", action: () => void openFolderEditor(null, folderId) }]
        : []),
      ...(folder().canRename ? [{ label: messages().rename, icon: "ti ti-edit", action: () => void openFolderEditor(folder()) }] : []),
      ...(folder().canManageSubscription
        ? [
            {
              label: folder().subscribed ? messages().unsubscribeOnProvider : messages().subscribeOnProvider,
              icon: folder().subscribed ? "ti ti-bookmark-off" : "ti ti-bookmark",
              disabled: changing(),
              action: () => folderMutation.mutate({ folder: folder(), action: "subscription" }),
            },
          ]
        : []),
      ...(folder().discoveryState === "missing"
        ? [
            {
              label: messages().removeFromMail,
              icon: "ti ti-folder-off",
              variant: "danger" as const,
              disabled: changing(),
              action: () => folderMutation.mutate({ folder: folder(), action: "dismiss" }),
            },
          ]
        : []),
      ...(folder().canDelete
        ? [
            {
              label: messages().deleteFolder,
              icon: "ti ti-trash",
              variant: "danger" as const,
              disabled: changing(),
              action: () => folderMutation.mutate({ folder: folder(), action: "delete" }),
            },
          ]
        : []),
    ];
    const menu = (): DropdownSection[] => [
      ...(canChooseDisplay()
        ? [
            {
              sectionLabel: messages().displaySection({ subfolders: row().descendantCount }),
              items: DISPLAYS.map((display) => {
                const description = choiceDescription(display);
                return {
                  choice: "radio" as const,
                  label: displayLabel(display),
                  icon: DISPLAY_ICONS[display],
                  description: description.text,
                  disabled: description.disabled || changing(),
                  checked: state().effectiveDisplay === display,
                  action: () => chooseDisplay(display),
                };
              }),
            },
          ]
        : []),
      ...(actions().length > 0 ? [{ items: actions() }] : []),
    ];
    const pending = () => pendingFolderId() === folderId;
    const expanded = () => !collapsedIds().has(folderId);
    const name = () => (row().path ? messages().folderInPath({ name: folder().name, path: row().path! }) : folder().name);
    // The label replaces the row's text for assistive technology, so it carries every note the row shows.
    const label = () =>
      [
        name(),
        ...(shared() ? [messages().sharedByProvider] : []),
        ...(row().group ? [messages().folderGroup({ count: row().descendantCount })] : []),
        ...(folder().subscribed === false ? [messages().notSubscribed] : []),
        status().spoken,
      ].join(", ");
    return (
      <li class="mail-folder-tree__item" aria-busy={pending() || undefined}>
        <div
          class="mail-folder-tree__row"
          style={{ "--mail-folder-depth": row().depth }}
          data-group={row().group ? "" : undefined}
          data-effective={state().effectiveDisplay}
          data-missing={folder().discoveryState === "missing" ? "" : undefined}
        >
          <For each={Array.from({ length: row().depth }, (_, level) => level)}>
            {(level) => <span class="mail-folder-tree__guide" style={{ "--mail-folder-level": level }} aria-hidden="true" />}
          </For>
          <Show when={row().hasChildren} fallback={<span class="mail-folder-tree__toggle" aria-hidden="true" />}>
            <button
              type="button"
              class="mail-folder-tree__toggle"
              aria-expanded={expanded()}
              aria-label={messages().subfoldersOf({ name: folder().name })}
              onClick={() => toggleCollapsed(folderId)}
            >
              <i class={`ti ${expanded() ? "ti-chevron-down" : "ti-chevron-right"}`} aria-hidden="true" />
            </button>
          </Show>
          <Dropdown.Root
            class="mail-folder-tree__menu-root"
            menuClass="mail-folder-menu"
            width="21rem"
            position="bottom-left"
            label={messages().folderMenu({ name: folder().name })}
            items={menu()}
            disabled={menu().length === 0}
          >
            <Dropdown.Trigger appearance="plain" class="mail-folder-tree__main" label={label()}>
              <Show when={!row().group}>
                <i class={`${folderIcon(folder())} mail-folder-tree__icon`} aria-hidden="true" />
              </Show>
              <span class="mail-folder-tree__copy">
                <span class="mail-folder-tree__name">{folder().name}</span>
                <Show when={shared()}>
                  <i class="ti ti-users mail-folder-tree__shared" title={messages().sharedByProvider} aria-hidden="true" />
                </Show>
                <Show when={row().group}>
                  <span class="mail-folder-tree__note">{messages().folderGroup({ count: row().descendantCount })}</span>
                </Show>
                <Show when={row().path}>{(path) => <span class="mail-folder-tree__note">{path()}</span>}</Show>
                <Show when={folder().subscribed === false}>
                  <span class="mail-folder-tree__note">{messages().notSubscribed}</span>
                </Show>
              </span>
              <span class="mail-folder-tree__state" data-kind={pending() ? "own" : status().kind}>
                <i class={pending() ? "ti ti-loader-2 animate-spin" : status().icon} aria-hidden="true" />
                <span class="mail-folder-tree__state-long">{status().long}</span>
                <span class="mail-folder-tree__state-short">{status().short}</span>
              </span>
            </Dropdown.Trigger>
          </Dropdown.Root>
        </div>
        <Show when={row().hasChildren && expanded()}>
          <ul class="mail-folder-tree__children" aria-label={messages().subfoldersOf({ name: folder().name })}>
            {folderList(folderId)}
          </ul>
        </Show>
      </li>
    );
  };

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p class="min-w-0 flex-[1_1_14rem] text-xs text-dimmed">{messages().folderVisibilityDescription}</p>
        <Button variant="secondary" size="sm" type="button" class="shrink-0" disabled={busy()} onClick={() => void openFolderEditor(null)}>
          <i class="ti ti-folder-plus" aria-hidden="true" />
          {messages().newFolder}
        </Button>
      </div>

      <Show
        when={rowIds().length > 0}
        fallback={
          <Placeholder
            icon="ti ti-folder-off"
            title={messages().noFoldersDiscovered}
            description={messages().noFoldersDiscoveredDescription}
          />
        }
      >
        <ul class="mail-folder-tree" aria-label={messages().folders}>
          {folderList(null)}
        </ul>
      </Show>

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
    </div>
  );
}
