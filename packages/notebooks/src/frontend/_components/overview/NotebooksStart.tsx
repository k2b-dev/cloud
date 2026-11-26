import { useLocale } from "@k2b/ui";
import { Band, List, Pane, Row, Text, Workspace } from "@k2b/ui/v2";
import { createSignal, For } from "solid-js";
import { notebooksPageMessages } from "../../messages";
import { createNoteCommands } from "../../note-commands";
import NewNotebookDialog, { type NewNotebookSource, type TemplateSummary } from "./NewNotebookDialog";

/** A template's sign as the v2 icon name. */
const sign = (icon: string) => icon.replace(/^ti ti-/, "");

/**
 * Notebooks for a person who has none yet. Everyone else never sees this page: `/app/notebooks` opens the notebook
 * they used last.
 *
 * Screen brief: a person opens Notebooks for the first time. They need, in this order: (1) that this is where their
 * first notebook starts, (2) what a notebook is for, (3) the ways to start, a blank notebook or a template with what
 * it holds. There is no data yet, so the hero is that statement, not a figure. The eye lands on the statement, then on
 * the ways to start, one row each. Each row keeps two lines at every width (name; what it holds): with no detail to
 * open, what a template holds is what a person chooses by, so it stays in the row instead of being cut on the phone.
 * No head: the rows are the ways to start, so a "+" there would only repeat them; on the phone the main action
 * floats, as everywhere in v2.
 *
 * k2b-ui gaps: the hero band in the app's colour with its own type step (DP); a readable measure for the band and the
 * rows in a wide pane (`Section measure`, MW #4320), until then they stand on the left of a wide page.
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
          {/* k2b-ui gap: hero band (DP); the statement stands in the strongest type step there is */}
          <Band label={t().firstNotebook}>
            <Text type="lead">{t().firstNotebook}</Text>
            <Text muted>{t().firstNotebookPurpose}</Text>
          </Band>
          <List label={t().firstNotebook}>
            <Row
              lines={[t().blankNotebook, t().blankNotebookHint]}
              // a neutral mark: a template has no data colour, and colour is for state and the one main action
              mark={{ icon: "notebook" }}
              onOpen={() => setCreating({ kind: "blank" })}
            />
            <For each={props.templates}>
              {(template) => (
                <Row
                  lines={[template.name, template.description]}
                  mark={{ icon: sign(template.icon) }}
                  onOpen={() => setCreating({ kind: "template", templateId: template.id })}
                />
              )}
            </For>
          </List>
        </Pane>
      </Workspace>
      <NewNotebookDialog templates={props.templates} source={creating()} onClose={() => setCreating(null)} />
    </>
  );
}
