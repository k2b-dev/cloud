import { useLocale } from "@k2b/ui";
import { Bar, Button, Empty, Pane, Text, Workspace } from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import { notebooksPageMessages } from "./messages";
import NewNotebookDialog, { type NotebookTemplate } from "./NewNotebookDialog";
import { createNoteCommands } from "./note-commands";

/**
 * Notebooks for a person who can open no notebook yet: the workspace says so where the notes would stand, and
 * "Neues Notizbuch" (blank or from a template) is its one action. Creating one opens it.
 */
export default function NoNotebooks(props: { templates: NotebookTemplate[] }) {
  createNoteCommands();
  const locale = useLocale();
  const t = createMemo(() => notebooksPageMessages.resolve([locale()]).t);
  const [creating, setCreating] = createSignal(false);
  return (
    <Workspace
      head={
        <Bar
          start={<Text type="body">{t().notebooks}</Text>}
          end={
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              {t().newNotebook}
            </Button>
          }
        />
      }
      primary={{ label: t().newNotebook, icon: "plus", onClick: () => setCreating(true) }}
    >
      <Show when={creating()}>
        <NewNotebookDialog templates={props.templates} close={() => setCreating(false)} />
      </Show>
      <Pane label={t().notebooks}>
        <Empty icon="notebook" text={t().noNotebooks} />
      </Pane>
    </Workspace>
  );
}
