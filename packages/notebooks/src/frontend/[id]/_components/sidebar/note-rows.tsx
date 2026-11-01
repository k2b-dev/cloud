import { AppWorkspace, Dropdown, type DropdownItem, ListContextMenu, useLocale } from "@k2b/ui";
import { type JSX, Show } from "solid-js";
import type { SidebarNote } from "../../../../lib/sidebar-tree";
import { notebookWorkspaceMessages } from "../../messages";

/** A note's title in a sidebar row, with its lock right after the text. `title` may run ahead of the saved one. */
export function NoteRowLabel(props: { note: SidebarNote; title?: string }) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return (
    <span class="flex min-w-0 items-center gap-1.5">
      <span class="k2b-truncate-fade">{(props.title ?? props.note.title) || t().untitled}</span>
      <Show when={props.note.lockedAt}>
        <i class="ti ti-lock shrink-0 text-xs text-amber-500" role="img" aria-label={t().locked} title={t().locked} />
      </Show>
    </span>
  );
}

/** The ⋯ button of a sidebar note row; with a mouse it shows on hover, focus, and the open note, and always on touch. */
export function NoteRowMenu(props: { note: SidebarNote; items: DropdownItem[] }) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const label = () => t().noteActions({ title: props.note.title || t().untitled });
  return (
    <AppWorkspace.SidebarItemActions visibility="hover">
      <Dropdown.Root position="bottom-right" width="12rem" items={props.items} lazy>
        <Dropdown.Trigger iconOnly label={label()} tooltip={label()} size="xs">
          <i class="ti ti-dots text-xs" />
        </Dropdown.Trigger>
      </Dropdown.Root>
    </AppWorkspace.SidebarItemActions>
  );
}

/**
 * Opens the menu of the note row under the pointer, or of the focused row with the Context Menu key or Shift+F10. A
 * right-click outside a row keeps the browser's own menu.
 */
export function NoteRowsContextMenu(props: { menu: (noteId: string) => DropdownItem[]; children: JSX.Element }) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  return (
    <ListContextMenu
      class="min-w-0"
      row="[data-k2b-nav-tree-id]"
      items={(row) => (row.dataset.k2bNavTreeId ? props.menu(row.dataset.k2bNavTreeId) : [])}
      label={t().noteActionsLabel}
    >
      {props.children}
    </ListContextMenu>
  );
}
