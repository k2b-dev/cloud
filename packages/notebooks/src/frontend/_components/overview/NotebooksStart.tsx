import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Inline, List, Mark, Pane, Row, Section, Text, Workspace } from "@k2b/ui/v2";
import { createSignal, For, Show } from "solid-js";
import { notebooksPageMessages } from "../../messages";
import { createNoteCommands } from "../../note-commands";
import NewNotebookDialog, { type NewNotebookSource, type TemplateSummary } from "./NewNotebookDialog";

/** One page a way to start makes: its title and the page it stands under. */
export type StartPage = { title: string; parent: string | null };
/** A template on the start page, with the pages it makes. */
export type StartTemplate = TemplateSummary & { pages: readonly StartPage[] };

/** The blank notebook's place in the address and the list. */
export const BLANK = "blank";

/** A template's sign as the v2 icon name. */
const sign = (icon: string) => icon.replace(/^ti ti-/, "");

/** Below this width the detail leaves (v2's phone), so a way to start opens the dialog right away. */
const phone = () => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;

/**
 * Notebooks for a person who has none yet. Everyone else never sees this page: `/app/notebooks` opens the notebook
 * they used last.
 *
 * Screen brief: a person opens Notebooks for the first time. They need, in this order: (1) that this is where their
 * first notebook starts and what a notebook is for, (2) the ways to start, a blank notebook or a template, (3) what
 * each way makes before they choose it. There is no data yet, so the hero is the statement, not a figure. Eye path:
 * the statement, the ways to start, the open one's pages beside them with its one main action. List and detail as the
 * list-detail recipe: the list keeps its width, large screens give the room to the detail. The open way to start is
 * in the address (`?template=`), so a reload shows the same. On the phone the detail leaves and a way to start opens
 * the dialog. Each list row keeps two lines (name; what it holds): it is what a person chooses by.
 *
 * k2b-ui gaps: the hero band in the app's colour with the figure step and a 40 px sign (DP); the tinted head of the
 * open object (DP); a readable measure in a wide list pane (MW #4320).
 */
export default function NotebooksStart(props: {
  templates: readonly StartTemplate[];
  blankPages: readonly StartPage[];
  open?: string | null;
}) {
  createNoteCommands();
  const locale = useLocale();
  const t = () => notebooksPageMessages.resolve([locale()]).t;
  const [creating, setCreating] = createSignal<NewNotebookSource | null>(null);
  const known = (id: string | null | undefined) =>
    id === BLANK || props.templates.some((template) => template.id === id) ? (id ?? null) : null;
  // the open way to start comes from the address; with none open, the detail's place says so (and the phone keeps the
  // list)
  const [open, setOpen] = createSignal<string | null>(known(props.open));
  const sourceOf = (id: string): NewNotebookSource => (id === BLANK ? { kind: "blank" } : { kind: "template", templateId: id });
  const choose = (id: string) => {
    if (phone()) {
      setCreating(sourceOf(id));
      return;
    }
    setOpen(id);
    const url = new URL(window.location.href);
    url.searchParams.set("template", id);
    window.history.replaceState(window.history.state, "", url);
  };
  const opened = () => {
    const id = open();
    if (id === null) return null;
    const template = props.templates.find((candidate) => candidate.id === id);
    return template
      ? { id: template.id, name: template.name, description: template.description, icon: sign(template.icon), pages: template.pages }
      : { id: BLANK, name: t().blankNotebook, description: t().blankNotebookHint, icon: "notebook", pages: props.blankPages };
  };
  return (
    <>
      <Workspace detail detailEmpty={{ icon: "notebook", text: t().chooseStart }}>
        <Pane.Split>
          <Pane label={t().notebooks} width={{ min: 320, default: 400 }}>
            {/* k2b-ui gap: hero band (DP); the statement stands in the strongest type step there is */}
            <Band label={t().firstNotebook}>
              <Text type="lead">{t().firstNotebook}</Text>
              <Text type="meta" muted>
                {t().firstNotebookPurpose}
              </Text>
            </Band>
            {/* k2b-ui gap: Tile onOpen (#4314) – the ways to start become tiles whose action opens the dialog (a real
                button); until it lands they stand as rows that open the same dialog or the way beside the list. */}
            <List label={t().firstNotebook}>
              <Row
                lines={[t().blankNotebook, t().blankNotebookHint]}
                // a neutral mark: a template has no data colour, and colour is for state and the one main action
                mark={{ icon: "notebook" }}
                current={open() === BLANK}
                onOpen={() => choose(BLANK)}
              />
              <For each={props.templates}>
                {(template) => (
                  <Row
                    lines={[template.name, template.description]}
                    mark={{ icon: sign(template.icon) }}
                    current={open() === template.id}
                    onOpen={() => choose(template.id)}
                  />
                )}
              </For>
            </List>
          </Pane>
          <Show when={opened()}>
            {(way) => (
              <Pane
                detail
                label={way().name}
                // the phone shows an open way to start as its own page (from a shared address): its way back is the list
                back={{ label: t().notebooks, href: "/app/notebooks" }}
                head={
                  // k2b-ui gap: tinted head of the open object (DP); its sign carries Notebooks' colour, the owner of what
                  // is made
                  <Bar
                    start={
                      <Inline>
                        <Mark icon={way().icon} color="var(--k2-app-text)" />
                        <Text type="lead">{way().name}</Text>
                      </Inline>
                    }
                    end={
                      <Button variant="primary" icon="plus" keep onClick={() => setCreating(sourceOf(way().id))}>
                        {t().create}
                      </Button>
                    }
                  />
                }
              >
                <Show when={way().description}>
                  <Band label={way().name}>
                    <Text muted>{way().description}</Text>
                  </Band>
                </Show>
                {/* no mark on the pages: the same page sign on every row would say nothing; the parent names the place */}
                <Section icon="files" title={t().pagesMade} count={way().pages.length}>
                  <For each={way().pages}>{(page) => <Row lines={[page.title]} meta={page.parent ?? undefined} />}</For>
                </Section>
              </Pane>
            )}
          </Show>
        </Pane.Split>
      </Workspace>
      <NewNotebookDialog templates={props.templates} source={creating()} onClose={() => setCreating(null)} />
    </>
  );
}
