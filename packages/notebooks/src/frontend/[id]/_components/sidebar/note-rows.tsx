import { AppWorkspace, ContextMenu, Dropdown, type DropdownItem, useLocale } from "@k2b/ui";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
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

const ROW = "[data-k2b-nav-tree-id]";

/**
 * Opens the menu of the note row under the pointer, or of the focused row with the Context Menu key or Shift+F10. A
 * right-click outside a row keeps the browser's own menu.
 */
export function NoteRowsContextMenu(props: { menu: (noteId: string) => DropdownItem[]; children: JSX.Element }) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [noteId, setNoteId] = createSignal<string | null>(null);
  let wrapper: HTMLDivElement | undefined;
  onMount(() => {
    // Capture runs before the menu's own handler: it picks the row, and without one the event never reaches the menu.
    const target = (event: Event, element: EventTarget | null) => {
      const id = (element as Element | null)?.closest<HTMLElement>(ROW)?.dataset.k2bNavTreeId;
      if (id) setNoteId(id);
      else event.stopPropagation();
    };
    const fromPointer = (event: Event) => target(event, event.target);
    const fromKey = (event: KeyboardEvent) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) target(event, document.activeElement);
    };
    wrapper?.addEventListener("contextmenu", fromPointer, true);
    wrapper?.addEventListener("keydown", fromKey, true);
    onCleanup(() => {
      wrapper?.removeEventListener("contextmenu", fromPointer, true);
      wrapper?.removeEventListener("keydown", fromKey, true);
    });
  });
  return (
    <div ref={wrapper} class="min-w-0">
      <ContextMenu items={noteId() ? props.menu(noteId()!) : []} tabIndex={-1} label={t().noteActionsLabel}>
        {props.children}
      </ContextMenu>
    </div>
  );
}
