import { useLocale } from "@k2b/ui";
import { List, Pane, Row, Section, Workspace } from "@k2b/ui/v2";
import { createSignal, For } from "solid-js";
import { notebooksPageMessages } from "../../messages";
import { createNoteCommands } from "../../note-commands";
import NewNotebookDialog, { type NewNotebookSource, type TemplateSummary } from "./NewNotebookDialog";

/** The signs stand in the app's ink, so the rows read as Notebooks' own ways to start. */
const appInk = "var(--k2-app-text)";

/** A template's sign as the v2 icon name. */
const sign = (icon: string) => icon.replace(/^ti ti-/, "");

/**
 * Notebooks for a person who has none yet: the ways to start, a blank notebook and each template with what it holds,
 * as rows that open the new-notebook dialog. Everyone else never sees this page: `/app/notebooks` opens the notebook
 * they used last.
 *
 * No head: the rows are the ways to start, so a "+" there would only repeat them, and v2 has no head that leaves the
 * phone. On the phone the main action floats, as everywhere in v2.
 *
 * k2b-ui gap (with DP): a `Row` has no tinted sign tile (the `k2-stile` of `Section` and `Group`), so the ways to
 * start carry a line icon in the app's ink; `Tiles` cannot open an action and have no colour, so they cannot be the
 * start cards yet; and no primitive holds rows to a readable measure in a wide pane, so at 1440 they stand on the
 * left of a wide page. Once DP's Tiles take a colour and an action, the ways to start become those cards.
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
          <Section icon="notebook" title={t().firstNotebook} summary={t().firstNotebookPurpose}>
            <List label={t().firstNotebook}>
              <Row
                lines={[t().blankNotebook, t().blankNotebookHint]}
                icon="notebook"
                color={appInk}
                onOpen={() => setCreating({ kind: "blank" })}
              />
              <For each={props.templates}>
                {(template) => (
                  <Row
                    lines={[template.name, template.description]}
                    icon={sign(template.icon)}
                    color={appInk}
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
