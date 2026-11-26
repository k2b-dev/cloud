import { useLocale } from "@k2b/ui";
import { Bar, Empty, Menu, type MenuEntry, Pane, Workspace } from "@k2b/ui/v2";
import { createSignal } from "solid-js";
import { notebooksPageMessages } from "../../messages";
import { createNoteCommands } from "../../note-commands";
import NewNotebookDialog, { type NewNotebookSource } from "./NewNotebookDialog";

export type TemplateSummary = { id: string; name: string; description: string; icon: string };

/** A template's sign as the v2 icon name. */
const sign = (icon: string) => icon.replace(/^ti ti-/, "");

/**
 * Notebooks for a person who has none yet: one sentence, and the one "+" in the head for the first notebook, blank or
 * from a template. Everyone else never sees this page: `/app/notebooks` opens the notebook they used last.
 */
export default function NotebooksStart(props: { templates: TemplateSummary[] }) {
  createNoteCommands();
  const locale = useLocale();
  const t = () => notebooksPageMessages.resolve([locale()]).t;
  const [creating, setCreating] = createSignal<NewNotebookSource | null>(null);
  // the names alone: a description beside them in a menu would cut the name
  const createItems = (): MenuEntry[] => [
    { label: t().blankNotebook, icon: "notebook", onClick: () => setCreating({ kind: "blank" }) },
    ...(props.templates.length > 0
      ? [
          {
            title: t().templates,
            items: props.templates.map((template) => ({
              label: template.name,
              icon: sign(template.icon),
              onClick: () => setCreating({ kind: "template" as const, template }),
            })),
          },
        ]
      : []),
  ];
  return (
    <>
      <Workspace head={<Bar end={<Menu icon="plus" variant="primary" label={t().newNotebook} items={createItems()} />} />}>
        <Pane label={t().notebooks}>
          {/* one way to the first notebook: the head's "+" (a symbol, so the phone keeps it) */}
          {/* k2b-ui gap: a page-wide Empty stands on the text edge like a list's, so 1440 shows a small sentence in a
              wide white page; Tiles only open links, so the ways to start (blank, each template) cannot stand as
              tiles that open the dialog. Reported to the coordinator. */}
          <Empty icon="notebook" text={t().noNotebooksYet} />
        </Pane>
      </Workspace>
      <NewNotebookDialog source={creating()} onClose={() => setCreating(null)} />
    </>
  );
}
