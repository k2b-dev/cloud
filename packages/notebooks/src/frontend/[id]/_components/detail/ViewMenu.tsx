import { navigateTo } from "@k2b/ssr/nav";
import { Dropdown, type DropdownItem, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount } from "solid-js";
import { buildNoteUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import { changeFullWidth, createFullWidth } from "../full-width";

/** Full width changes nothing below this width, so the option stays away there, as the command does. */
const WIDE_SCREEN_QUERY = "(min-width: 64rem)";

export type ViewMenuProps = {
  mode: "edit" | "read";
  notebookId: string;
  noteId: string;
  /** Edit is offered only to writers of a note that is not locked. */
  canEdit: boolean;
  /** Formatted or Markdown text; only the editor has both. */
  isRich: boolean;
  onToggleRich: () => void;
  /** The server's full-width cookie value, so the first frame matches. */
  fullWidth: boolean;
};

/**
 * "View": how the note opens (Edit, Read, Book), how the editor shows its text, and the personal full-width
 * preference. One labelled menu instead of loose links and a section of its own; a sheet on phones.
 */
export function ViewMenu(props: ViewMenuProps) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const fullWidth = createFullWidth(props.fullWidth);
  const [wide, setWide] = createSignal(false);
  onMount(() => {
    const query = window.matchMedia(WIDE_SCREEN_QUERY);
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  });

  const open = (mode: "write" | "readonly" | "book") => () => void navigateTo(buildNoteUrl(props.notebookId, props.noteId, mode));
  const items = (): DropdownItem[] => [
    {
      sectionLabel: t().openAs,
      layout: "row",
      items: [
        ...(props.canEdit
          ? [{ label: t().openAsEdit, icon: "ti ti-pencil", choice: "radio" as const, checked: props.mode === "edit", action: open("write") }]
          : []),
        { label: t().openAsRead, icon: "ti ti-eye", choice: "radio" as const, checked: props.mode === "read", action: open("readonly") },
        { label: t().openAsBook, icon: "ti ti-book", choice: "radio" as const, checked: false, action: open("book") },
      ],
    },
    ...(props.mode === "edit"
      ? [
          {
            sectionLabel: t().textView,
            layout: "row" as const,
            items: [
              {
                label: t().formattedText,
                icon: "ti ti-typography",
                choice: "radio" as const,
                // Accessors, so a menu that stays open, or its phone sheet, follows the change.
                checked: () => props.isRich,
                closeOnSelect: false,
                action: () => {
                  if (!props.isRich) props.onToggleRich();
                },
              },
              {
                label: t().markdownText,
                icon: "ti ti-markdown",
                choice: "radio" as const,
                checked: () => !props.isRich,
                closeOnSelect: false,
                action: () => {
                  if (props.isRich) props.onToggleRich();
                },
              },
            ],
          },
        ]
      : []),
    ...(wide()
      ? [
          {
            items: [
              {
                label: t().fullWidth,
                description: t().fullWidthHint,
                choice: "checkbox" as const,
                checked: () => fullWidth(),
                closeOnSelect: false,
                action: () => changeFullWidth(!fullWidth()),
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <Dropdown.Root items={items()} align="end" label={t().view} phone="sheet" width="17rem" class="notebook-view-menu">
      <Dropdown.Trigger size="sm" variant="secondary" class="notebook-view-menu__trigger">
        <i class="ti ti-adjustments-horizontal" aria-hidden="true" />
        {t().view}
        <i class="ti ti-chevron-down notebook-view-menu__chevron" aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
