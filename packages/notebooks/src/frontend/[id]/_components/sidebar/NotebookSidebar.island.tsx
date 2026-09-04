import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { AppWorkspace, Button, prompts, SelectChip, Tooltip, useLocale } from "@k2b/ui";
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
import NoteTree from "./NoteTree";
import TagsButton from "./TagsButton";
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

  return (
    <AppWorkspace.Sidebar resizable>
      <AppWorkspace.SidebarMobileTrigger label={notebook().name} />

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

      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileItems>
          {canWrite && (
            <div style={`view-transition-name:${vt("create-mobile")}`}>
              <CreateNoteButton notebookId={notebook().id} variant="chip" />
            </div>
          )}
          {homepageHref() && (
            <AppWorkspace.SidebarItem
              href={homepageHref()!}
              icon="ti ti-home"
              active={homepageIsActive()}
              navigation="enhanced"
              scroll="top"
              onNavigate={handleSameNotebookNoteNavigate}
              data={{ "notebooks-homepage-note-id": homepageNote()?.id }}
              viewTransitionName={vt("homepage-mobile")}
            >
              {t().homepage}
            </AppWorkspace.SidebarItem>
          )}
          <AppWorkspace.SidebarItem
            href={allNotebooksHref}
            icon="ti ti-notebook"
            navigation="document"
            viewTransitionName={vt("all-notebooks-mobile")}
          >
            {t().allNotebooks}
          </AppWorkspace.SidebarItem>
          <div style={`view-transition-name:${vt("search-mobile")}`}>
            <SearchButton notebookId={notebook().id} notebookName={notebook().name} variant="sidebar-mobile" />
          </div>
          <AppWorkspace.SidebarItem
            href={attachmentsHref()}
            icon="ti ti-paperclip"
            meta={attachmentCount()}
            navigation="document"
            viewTransitionName={vt("attachments-mobile")}
          >
            {t().attachments}
          </AppWorkspace.SidebarItem>
          {hasTags() && (
            <div style={`view-transition-name:${vt("tags-mobile")}`}>
              <TagsButton notebookId={notebook().id} tags={tags()} variant="sidebar-mobile" presentationMode={props.ctx.presentationMode} />
            </div>
          )}
          <NotebookSettingsButton
            notebook={notebook()}
            tree={noteTree()}
            permission={props.ctx.permission}
            dateConfig={props.ctx.dateConfig}
            viewTransitionName={vt("settings-mobile")}
          />
          <SelectChip
            aria-label={t().sortNotes}
            value={treeSort()}
            onValueChange={changeTreeSort}
            icon="ti ti-arrows-sort"
            options={treeSortOptions()}
          />
        </AppWorkspace.SidebarMobileItems>
        <AppWorkspace.SidebarMobileBody scrollPreserveKey={`notebooks-mobile-sidebar-${notebook().id}`}>
          {renderTreeView()}
        </AppWorkspace.SidebarMobileBody>
      </AppWorkspace.SidebarMobile>

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
  );
}
