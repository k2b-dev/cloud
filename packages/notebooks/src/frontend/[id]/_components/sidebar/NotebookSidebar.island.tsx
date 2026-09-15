import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { navigateToNotebookNote } from "../../../lib/soft-navigation";
import { openNoteSearchPrompt } from "../search/openNoteSearchPrompt";
import { openNotebookSettingsDialog } from "../settings/NotebookSettingsPanel";
import { useFavoriteNotes } from "./useFavoriteNotes";
import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { createNavigation, type NavigationItem, AppWorkspace, Button, prompts, SelectChip, Tooltip, useLocale } from "@k2b/ui";
import { createMemo, createSignal, Show } from "solid-js";
import { requestSoftNoteNavigation } from "../../../lib/soft-navigation";
import { buildAttachmentsUrl, buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { resolveSameNotebookNoteTarget } from "../editor/note-navigation";
import SearchButton from "../search/SearchButton";
import NotebookSettingsButton from "../settings/NotebookSettingsButton";
import { writeSettings } from "../settings/NotebookSettingsStore";
import CreateNoteButton from "./CreateNoteButton";
import NotebookNavigator from "./NotebookNavigator";
import NoteTree, { noteActionItems, useNoteActions } from "./NoteTree";
import TagsButton, { openTagsModal } from "./TagsButton";
import { type NoteTreeSort, sortNoteTree } from "./tree-utils";
import type { NotebookContext, NoteTreeNode } from "./types";
import { useNotebookWorkspaceState } from "./useNotebookWorkspaceState";

type Props = {
  ctx: NotebookContext;
};

const findNoteByShortId = (nodes: NoteTreeNode[], shortId: string | null): NoteTreeNode | null => {
  if (!shortId) return null;
  for (const node of nodes) {
    if (node.id === shortId) return node;
    const child = findNoteByShortId(node.children, shortId);
    if (child) return child;
  }
  return null;
};

export default function NotebookSidebar(props: Props) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const {
    notebook,
    noteTree,
    favoriteNoteIds,
    selectedNoteId,
    tags,
    attachmentCount,
    workspaceError,
    workspaceRefreshing,
    refreshWorkspace,
  } = useNotebookWorkspaceState(props.ctx);
  const canWrite = props.ctx.permission === "write" || props.ctx.permission === "admin";
  const navigatorMode = () => props.ctx.settings.sidebarMode === "navigator";
  const [treeSort, setTreeSort] = createSignal<NoteTreeSort>(props.ctx.settings.treeSort);
  const sortedTree = createMemo(() => sortNoteTree(noteTree(), treeSort()));
  const treeSortOptions = () => [
    { value: "title" as const, label: t().nameSort },
    { value: "updated" as const, label: t().updatedSort },
    { value: "created" as const, label: t().createdSort },
  ];
  const changeTreeSort = (value: NoteTreeSort) => {
    setTreeSort(value);
    writeSettings(notebook().id, { treeSort: value });
  };
  const attachmentsHref = () => buildAttachmentsUrl(notebook().id, props.ctx.presentationMode);
  const hasTags = () => tags().length > 0;
  const allNotebooksHref = "/app/notebooks";
  const homepageNote = createMemo(() => findNoteByShortId(noteTree(), notebook().homepageNoteId));
  const homepageHref = () => (homepageNote() ? buildNoteUrl(notebook().id, homepageNote()!.id, props.ctx.presentationMode) : null);
  const homepageIsActive = () => homepageNote()?.id === selectedNoteId();
  const vt = (key: string) => `notebook-sidebar-${notebook().id}-${key}`;

  const explainMissingHomepage = () =>
    void prompts.alert(t().noHomepageDescription, {
      title: t().noHomepage,
      icon: "ti ti-home",
    });

  const handleSameNotebookNoteNavigate = async (nav: LinkNavigateEvent) => {
    const target = resolveSameNotebookNoteTarget(nav.url.href, window.location.href, notebook().id)?.canonicalHref;
    if (!target) {
      nav.fallback();
      return;
    }

    if (`${window.location.pathname}${window.location.search}` === target) {
      nav.replaceWith(target);
      return;
    }

    const result = await requestSoftNoteNavigation(target, { push: false });
    if (result.kind === "fallback") {
      nav.fallback(target);
      return;
    }
    if (result.kind === "applied") nav.push(result.href);
  };

  const renderTreeView = () => (
    <NoteTree
      tree={sortedTree()}
      notebookId={notebook().id}
      notebookName={notebook().name}
      selectedNoteId={selectedNoteId()}
      canWrite={canWrite}
      showSearch={false}
      showHeaderActions={false}
      favoriteNoteIds={[...favoriteNoteIds()]}
      presentationMode={props.ctx.presentationMode}
    />
  );

  const actions = useNoteActions(notebook().id, noteTree);
  const favorites = useFavoriteNotes({ notebookId: notebook().id, initialFavoriteNoteIds: () => [...favoriteNoteIds()] });
  const noteActions = (node: NoteTreeNode) =>
    noteActionItems(node, actions, t()).flatMap((item) => ("items" in item ? item.items : [item]));
  const noteEntry = (node: NoteTreeNode): NavigationItem => ({
    id: `note:${node.id}`,
    label: node.title || t().untitled,
    icon: node.lockedAt ? "ti ti-lock" : "ti ti-file-text",
    href: buildNoteUrl(notebook().id, node.id, props.ctx.presentationMode),
    active: selectedNoteId() === node.id,
    children: node.children.map(noteEntry),
    actions: [
      {
        id: `favorite:${node.id}`,
        action: `favorite:${node.id}`,
        label: favorites.favoriteNoteIds().has(node.id) ? t().removeFavorite : t().addFavorite,
        icon: "ti ti-star",
      },
      ...(canWrite
        ? noteActions(node).map((item) => ({
            id: `note-action:${node.id}:${item.icon}`,
            action: `note-action:${node.id}:${item.icon}`,
            label: item.label,
            icon: item.icon,
            disabled: item.disabled || actions.loading(),
          }))
        : []),
    ],
  });
  const mobileNavigation = createNavigation({
    items: () => [
      ...(canWrite ? [{ id: "new", label: t().newNote, icon: "ti ti-plus", action: "new", disabled: actions.loading() }] : []),
      ...(homepageHref()
        ? [
            {
              id: "home",
              label: t().homepage,
              icon: "ti ti-home",
              href: homepageHref()!,
              active: homepageIsActive(),
              navigation: "enhanced" as const,
              scroll: "top" as const,
            },
          ]
        : []),
      { id: "all", label: t().allNotebooks, icon: "ti ti-notebook", href: allNotebooksHref },
      { id: "search", label: t().searchNotes, icon: "ti ti-search", action: "search" },
      { id: "attachments", label: t().attachments, icon: "ti ti-paperclip", href: attachmentsHref(), badge: attachmentCount() },
      ...(hasTags() ? [{ id: "tags", label: t().tags, icon: "ti ti-hash", action: "tags", badge: tags().length }] : []),
      ...(workspaceError()
        ? [
            {
              id: "retry",
              label: t().retry,
              description: t().updateLoadFailed,
              icon: "ti ti-refresh",
              action: "retry",
              disabled: workspaceRefreshing(),
            },
          ]
        : []),
      {
        id: "sort",
        label: t().sortNotes,
        icon: "ti ti-arrows-sort",
        children: treeSortOptions().map((option) => ({
          id: `sort:${option.value}`,
          label: option.label,
          action: `sort:${option.value}`,
          active: treeSort() === option.value,
        })),
      },
      ...sortedTree().map(noteEntry),
      { id: "settings", label: t().settings, icon: "ti ti-settings", action: "settings" },
    ],
    onNavigate: handleSameNotebookNoteNavigate,
    onAction: async (action) => {
      if (action === "new") {
        actions.handleCreateNote();
        return;
      }
      if (action === "retry") {
        await refreshWorkspace();
        return;
      }
      if (action === "tags") {
        await openTagsModal(notebook().id, tags(), locale(), props.ctx.presentationMode);
        return;
      }
      if (action === "settings") {
        await openNotebookSettingsDialog({
          notebook: notebook(),
          tree: noteTree(),
          isAdmin: props.ctx.permission === "admin",
          canWrite,
          dateConfig: props.ctx.dateConfig,
        });
        return;
      }
      if (action === "search") {
        const picked = await openNoteSearchPrompt(notebook().id, notebook().name, locale());
        if (picked) await navigateToNotebookNote(buildNoteUrl(notebook().id, picked.id, props.ctx.presentationMode));
        return;
      }
      if (action.startsWith("sort:")) {
        const option = treeSortOptions().find((option) => `sort:${option.value}` === action);
        if (option) changeTreeSort(option.value);
        return;
      }
      if (action.startsWith("favorite:")) {
        const node = findNoteByShortId(noteTree(), action.slice(9));
        if (node) await favorites.toggleFavorite(node);
        return;
      }
      if (action.startsWith("note-action:")) {
        const rest = action.slice(12);
        const index = rest.indexOf(":");
        const node = findNoteByShortId(noteTree(), rest.slice(0, index));
        const item = node && noteActions(node).find((item) => item.icon === rest.slice(index + 1));
        if (item && !item.disabled) item.action?.();
      }
    },
  });
  return (
    <>
      <WorkspaceNavigationProvider navigation={mobileNavigation} label={notebook().name} />
      <AppWorkspace.Sidebar resizable>
        <Show when={workspaceError()}>
          <div
            role="alert"
            class="mx-2 mt-2 flex items-center justify-between gap-2 rounded-md bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
          >
            <span>{t().updateLoadFailed}</span>
            <Button type="button" variant="ghost" size="xs" loading={workspaceRefreshing()} onClick={() => void refreshWorkspace()}>
              {t().retry}
            </Button>
          </div>
        </Show>

        <AppWorkspace.SidebarDesktop>
          <Show
            when={navigatorMode()}
            fallback={
              <>
                <div class="flex flex-col gap-2">
                  <AppWorkspace.SidebarIconGrid columns={3}>
                    {canWrite && <CreateNoteButton notebookId={notebook().id} variant="icon" viewTransitionName={vt("create-desktop")} />}
                    <SearchButton
                      notebookId={notebook().id}
                      notebookName={notebook().name}
                      variant="workspace-icon"
                      viewTransitionName={vt("search-desktop")}
                    />
                    <Tooltip.Anchor content={homepageHref() ? t().homepage : t().setHomepage} class="w-full">
                      <AppWorkspace.SidebarIconAction
                        href={homepageHref()}
                        icon="ti ti-home"
                        label={homepageHref() ? t().homepage : t().setHomepage}
                        active={homepageIsActive()}
                        navigation="enhanced"
                        scroll="top"
                        onNavigate={handleSameNotebookNoteNavigate}
                        viewTransitionName={vt("homepage-desktop")}
                        onClick={homepageHref() ? undefined : explainMissingHomepage}
                      />
                    </Tooltip.Anchor>
                    <Tooltip.Anchor content={t().allNotebooks} class="w-full">
                      <AppWorkspace.SidebarIconAction
                        href={allNotebooksHref}
                        icon="ti ti-library"
                        label={t().allNotebooks}
                        navigation="document"
                        viewTransitionName={vt("all-notebooks-desktop")}
                      />
                    </Tooltip.Anchor>
                    <Tooltip.Anchor content={t().attachmentCount({ count: attachmentCount() })} class="w-full">
                      <AppWorkspace.SidebarIconAction
                        href={attachmentsHref()}
                        icon="ti ti-paperclip"
                        label={t().attachmentCount({ count: attachmentCount() })}
                        navigation="document"
                        viewTransitionName={vt("attachments-desktop")}
                      />
                    </Tooltip.Anchor>
                    {hasTags() && (
                      <TagsButton
                        notebookId={notebook().id}
                        tags={tags()}
                        variant="icon"
                        viewTransitionName={vt("tags-desktop")}
                        presentationMode={props.ctx.presentationMode}
                      />
                    )}
                  </AppWorkspace.SidebarIconGrid>
                </div>

                <AppWorkspace.SidebarBody scrollPreserveKey={`notebooks-simple-sidebar-${notebook().id}`}>
                  <AppWorkspace.SidebarSection
                    title={t().notes}
                    class="min-h-0 flex-1"
                    actions={
                      <Tooltip.Anchor content={t().sortNotes}>
                        <SelectChip
                          aria-label={t().sortNotes}
                          value={treeSort()}
                          onValueChange={changeTreeSort}
                          icon="ti ti-arrows-sort"
                          iconOnly
                          size="xs"
                          options={treeSortOptions()}
                        />
                      </Tooltip.Anchor>
                    }
                  >
                    {renderTreeView()}
                  </AppWorkspace.SidebarSection>
                </AppWorkspace.SidebarBody>
                <AppWorkspace.SidebarFooter>
                  <NotebookSettingsButton
                    notebook={notebook()}
                    tree={noteTree()}
                    permission={props.ctx.permission}
                    dateConfig={props.ctx.dateConfig}
                    viewTransitionName={vt("settings-desktop")}
                  />
                </AppWorkspace.SidebarFooter>
              </>
            }
          >
            <NotebookNavigator
              notebook={notebook()}
              tree={noteTree()}
              selectedNoteId={selectedNoteId()}
              permission={props.ctx.permission}
              canWrite={canWrite}
              favoriteNoteIds={[...favoriteNoteIds()]}
              tags={tags()}
              initialSortMode={props.ctx.settings.navigatorSort}
              dateConfig={props.ctx.dateConfig}
              initialQuery={props.ctx.navigatorQuery}
              presentationMode={props.ctx.presentationMode}
            />
          </Show>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
    </>
  );
}
