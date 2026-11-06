import { Dropdown, useLocale } from "@k2b/ui";
import { createMemo } from "solid-js";
import type { PageTemplateSummary } from "@/lib/page-templates";
import { notebookWorkspaceMessages } from "../../messages";
import { type NewNoteMenuChoice, newNoteMenuModel } from "./page-template-menu";

/**
 * The sidebar's "new note" button as a menu: Enter twice makes a blank note, a template row makes a note from it,
 * and "Manage templates…" opens the notebook's settings. The phone opens it as a sheet.
 */
export default function NewNoteMenu(props: {
  templates: readonly PageTemplateSummary[];
  choose: (choice: NewNoteMenuChoice) => void;
  pending: boolean;
}) {
  const locale = useLocale();
  const t = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const model = createMemo(() => newNoteMenuModel({ templates: props.templates, t: t(), choose: props.choose }));
  return (
    <Dropdown.Root
      items={model().items}
      search={model().search}
      label={t().newNote}
      icons="tile"
      phone="sheet"
      width="18.75rem"
      disabled={props.pending}
      sheetTop={() => <p class="px-3 pb-1 text-[0.9375rem] font-semibold">{t().newNote}</p>}
    >
      <Dropdown.Trigger iconOnly label={t().newNote} tooltip={t().newNoteShortcut}>
        <i class={props.pending ? "ti ti-loader-2 animate-spin" : "ti ti-pencil-plus"} aria-hidden="true" />
      </Dropdown.Trigger>
    </Dropdown.Root>
  );
}
