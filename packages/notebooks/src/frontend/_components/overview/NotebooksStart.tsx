import { useLocale } from "@k2b/ui";
import { List, Pane, Row, Section, Workspace } from "@k2b/ui/v2";
import { createSignal, For } from "solid-js";
import { notebooksPageMessages } from "../../messages";
import { createNoteCommands } from "../../note-commands";
import NewNotebookDialog, { type NewNotebookSource, type TemplateSummary } from "./NewNotebookDialog";

export type { TemplateSummary } from "./NewNotebookDialog";

/** A template's sign as the v2 icon name. */
const sign = (icon: string) => icon.replace(/^ti ti-/, "");

/**
 * Notebooks for a person who has none yet: the ways to start, a blank notebook and each template with what it holds,
 * as rows that open the new-notebook dialog. Everyone else never sees this page: `/app/notebooks` opens the notebook
 * they used last.
 *
 * No head: the rows are the ways to start, so a "+" there would only repeat them, and v2 has no head that leaves the
 * phone (k2b-ui gap: a head on wide screens only). On the phone the main action floats, as everywhere in v2.
 */
export default function NotebooksStart(props: { templates: TemplateSummary[] }) {
  createNoteCommands();
  const locale = useLocale();
  const t = () => notebooksPageMessages.resolve([locale()]).t;
  const [creating, setCreating] = createSignal<NewNotebookSource | null>(null);
  return (
    <>
      <Workspace primary={{ label: t().newNotebook, icon: "plus", onClick: () => setCreating({ kind: "blank" }) }}>
        <Pane label={t().notebooks}>
          <Section icon="notebook" title={t().firstNotebook} summary={t().noNotebooksYet}>
            <List label={t().firstNotebook}>
              <Row lines={[t().blankNotebook, t().blankNotebookHint]} icon="notebook" onOpen={() => setCreating({ kind: "blank" })} />
              <For each={props.templates}>
                {(template) => (
                  <Row
                    lines={[template.name, template.description]}
                    icon={sign(template.icon)}
                    onOpen={() => setCreating({ kind: "template", templateId: template.id })}
                  />
                )}
              </For>
            </List>
          </Section>
        </Pane>
      </Workspace>
      <NewNotebookDialog templates={props.templates} source={creating()} onClose={() => setCreating(null)} />
    </>
  );
}
