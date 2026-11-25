import { AppWorkspace, Button, Dropdown, IconButton, NoticeCard, Placeholder, SelectChip, Tooltip } from "@k2b/ui";
import { For, Show } from "solid-js";
import { openNoteSearchPrompt } from "../search/openNoteSearchPrompt";
import NewNoteMenu from "./NewNoteMenu";
import NoteTree, { focusTreeRow, placementForMove } from "./NoteTree";
import { NoteRowLabel, NoteRowMenu, NoteRowsContextMenu } from "./note-rows";
import { type useNotebookSidebar, withoutPagingRows } from "./notebook-sidebar-state";

/**
 * The notebook sidebar's content on a wide screen: switcher, new note, search, quick filters, the note tree or the
 * filtered list, and Links, Attachments and Settings at its foot. The v1 sidebar frames it in `AppWorkspace.Sidebar`; the
 * v2 workspace puts it in its `sidebar` slot until v2 has a tree (k2b-ui gap: Nav tree).
 */
export default function NotebookSidebarBody(props: {
  sidebar: ReturnType<typeof useNotebookSidebar>;
  current?: "attachments" | "graph" | "notes";
}) {
  const {
    t,
    notebook,
    tree,
    list,
    titleOf,
    tags,
    attachmentCount,
    pageTemplates,
    workspaceError,
    workspaceRefreshing,
    refreshWorkspace,
    treeSort,
    treeSortOptions,
    changeTreeSort,
    canWrite,
    orderable,
    attachmentsHref,
    graphHref,
    currentNoteId,
    openSettings,
    chooseNewNote,
    filter,
    setFilter,
    toggleFilter,
    listedNotes,
    filterLabel,
    tagFilter,
    toggleTag,
    listHref,
    listMeta,
    actions,
    noteMenu,
    listMenu,
    isHomepage,
    switcher,
  } = props.sidebar;
  return (
    <>
      <div class="notebook-sidebar-head">
        <AppWorkspace.SidebarSwitcher {...switcher()} />
        <Show when={canWrite}>
          <NewNoteMenu templates={pageTemplates()} choose={chooseNewNote} pending={actions.loading()} />
        </Show>
      </div>

      <Button
        variant="input"
        align="start"
        class="notebook-sidebar-search"
        onClick={() => openNoteSearchPrompt(notebook().id, notebook().name)}
      >
        <i class="ti ti-search" aria-hidden="true" />
        <span>{t().searchNotes}</span>
      </Button>

      <div class="notebook-sidebar-chips">
        <Button
          size="xs"
          variant="subtle"
          class="notebook-sidebar-chip"
          aria-pressed={filter().view === "favorites"}
          onClick={() => toggleFilter("favorites")}
        >
          <i class="ti ti-star" aria-hidden="true" />
          <span class="k2b-truncate-fade">{t().favorites}</span>
        </Button>
        <Button
          size="xs"
          variant="subtle"
          class="notebook-sidebar-chip"
          aria-pressed={filter().view === "recents"}
          onClick={() => toggleFilter("recents")}
        >
          <i class="ti ti-clock" aria-hidden="true" />
          <span class="k2b-truncate-fade">{t().recent}</span>
        </Button>
        <Show when={tags().length > 0 || tagFilter()}>
          <Dropdown.Root
            position="bottom-left"
            label={t().tags}
            items={[
              {
                sectionLabel: t().tags,
                items: tags().map((tag) => ({
                  icon: "ti ti-hash",
                  label: tag.tag,
                  description: t().noteCount({ count: tag.count }),
                  choice: "radio" as const,
                  checked: tagFilter() === tag.tag,
                  action: () => toggleTag(tag.tag),
                })),
              },
            ]}
          >
            <Dropdown.Trigger
              size="xs"
              variant="subtle"
              class="notebook-sidebar-chip"
              label={tagFilter() ? t().tagFilter({ tag: tagFilter()! }) : t().tags}
              aria-current={tagFilter() ? "true" : undefined}
            >
              <i class="ti ti-hash" aria-hidden="true" />
              <span class="k2b-truncate-fade">{tagFilter() ?? t().tags}</span>
              <i class="ti ti-chevron-down notebook-sidebar-chip__chevron" aria-hidden="true" />
            </Dropdown.Trigger>
          </Dropdown.Root>
        </Show>
      </div>

      <Show when={workspaceError()}>
        <NoticeCard role="alert" tone="danger" title={t().updateLoadFailed}>
          <Button variant="secondary" size="xs" loading={workspaceRefreshing()} onClick={() => void refreshWorkspace()}>
            {t().retry}
          </Button>
        </NoticeCard>
      </Show>

      <AppWorkspace.SidebarBody scrollPreserveKey={`notebooks-sidebar-${notebook().id}`}>
        <Show
          when={filter().view}
          fallback={
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
              <NoteTree
                tree={tree}
                titleOf={titleOf}
                notebookId={notebook().id}
                selectedNoteId={currentNoteId()}
                presentationMode={props.sidebar.presentationMode}
                homepageId={notebook().homepageNoteId}
                onMove={orderable() ? (move) => actions.handlePlace(move.id, placementForMove(withoutPagingRows(move))) : undefined}
                noteMenu={noteMenu}
              />
            </AppWorkspace.SidebarSection>
          }
        >
          <div class="notebook-sidebar-filter">
            <span class="notebook-sidebar-filter__label k2b-truncate-fade">
              {filterLabel()} <small>{t().noteCount({ count: list.total() })}</small>
            </span>
            <IconButton size="xs" label={t().clearFilter} tooltip={t().clearFilter} onClick={() => setFilter({})}>
              <i class="ti ti-x" />
            </IconButton>
          </div>
          <Show
            when={listedNotes().length > 0 || !list.loaded()}
            fallback={
              <Placeholder
                variant="inline"
                align="left"
                icon={filter().view === "favorites" ? "ti ti-star" : "ti ti-file-text"}
                description={filter().view === "favorites" ? t().noFavorites : t().noNotesHere}
              />
            }
          >
            <NoteRowsContextMenu menu={listMenu}>
              <AppWorkspace.NavTree ariaLabel={filterLabel()} selectedId={currentNoteId()}>
                <Show when={!list.loaded() && !list.error()}>
                  <AppWorkspace.NavTree.Item id="loading:list" label={t().loadingNotes} icon="ti ti-loader-2 animate-spin" disabled />
                </Show>
                <For each={listedNotes()}>
                  {(note) => (
                    <AppWorkspace.NavTree.Item
                      id={note.id}
                      label={<NoteRowLabel note={note} title={titleOf(note)} />}
                      description={listMeta(note)}
                      icon={isHomepage(note) ? "ti ti-home" : "ti ti-file-text"}
                      iconLabel={isHomepage(note) ? t().homepage : undefined}
                      href={listHref(note)}
                      navigation="document"
                      actions={<NoteRowMenu note={note} items={noteMenu(note, null)} />}
                    />
                  )}
                </For>
                <Show when={list.hasMore()}>
                  <AppWorkspace.NavTree.Item
                    id="more:list"
                    label={t().moreNotes({ count: list.total() - listedNotes().length })}
                    icon={list.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-chevrons-down"}
                    class="notebook-tree-more"
                    onSelect={() => {
                      const shown = listedNotes().length;
                      void list.showMore().then(() => focusTreeRow(listedNotes()[shown]?.id));
                    }}
                  />
                </Show>
              </AppWorkspace.NavTree>
            </NoteRowsContextMenu>
          </Show>
        </Show>
      </AppWorkspace.SidebarBody>

      {/* Marking a footer item as the current page also names it, so the workspace head shows no way up beside it. */}
      <AppWorkspace.SidebarFooter class="notebook-sidebar-foot">
        <AppWorkspace.SidebarItem icon="ti ti-affiliate" href={graphHref()} active={props.current === "graph"}>
          {t().noteLinks}
        </AppWorkspace.SidebarItem>
        <AppWorkspace.SidebarItem
          icon="ti ti-paperclip"
          href={attachmentsHref()}
          active={props.current === "attachments"}
          meta={attachmentCount() > 0 ? attachmentCount() : undefined}
        >
          {t().attachments}
        </AppWorkspace.SidebarItem>
        <AppWorkspace.SidebarItem icon="ti ti-settings" onClick={() => void openSettings()}>
          {t().settings}
        </AppWorkspace.SidebarItem>
      </AppWorkspace.SidebarFooter>
    </>
  );
}
