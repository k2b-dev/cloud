import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Inline, List, Mark, Pane, Row, Section, Text, Tiles, Workspace } from "@k2b/ui/v2";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
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
 * the statement, the ways to start, the open one's pages beside them with its one main action. With none open, the
 * ways stand as large cards across the page, each with a short preview (how many pages it makes and the first of
 * them), so nothing waits beside an empty detail. With one open (`?template=`, so a reload shows the same), the
 * list-detail recipe: the list keeps its width, large screens give the room to the open way's pages. A card opens its
 * way in place and back returns to the cards. On the phone a card or row opens the dialog. Each list row keeps two
 * lines (name; what it holds): it is what a person chooses by.
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
  /** Opens a way to start: the dialog on the phone, beside the list elsewhere. From the cards it is a new entry in the
   * history, so back returns to them; between rows it replaces the open one. */
  const choose = (id: string, fromCards = false) => {
    if (phone()) {
      setCreating(sourceOf(id));
      return;
    }
    setOpen(id);
    const url = new URL(window.location.href);
    url.searchParams.set("template", id);
    if (fromCards) window.history.pushState(window.history.state, "", url);
    else window.history.replaceState(window.history.state, "", url);
  };
  onMount(() => {
    const follow = () => setOpen(known(new URL(window.location.href).searchParams.get("template")));
    window.addEventListener("popstate", follow);
    onCleanup(() => window.removeEventListener("popstate", follow));
  });
  const opened = () => {
    const id = open();
    if (id === null) return null;
    const template = props.templates.find((candidate) => candidate.id === id);
    return template
      ? { id: template.id, name: template.name, description: template.description, icon: sign(template.icon), pages: template.pages }
      : { id: BLANK, name: t().blankNotebook, description: t().blankNotebookHint, icon: "notebook", pages: props.blankPages };
  };
  const ways = () => [
    { id: BLANK, name: t().blankNotebook, description: t().blankNotebookHint, icon: "notebook", pages: props.blankPages },
    ...props.templates.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      icon: sign(template.icon),
      pages: template.pages,
    })),
  ];
  const statement = () => (
    // k2b-ui gap: hero band (DP); the statement stands in the strongest type step there is
    <Band label={t().firstNotebook}>
      <Text type="lead">{t().firstNotebook}</Text>
      <Text type="meta" muted>
        {t().firstNotebookPurpose}
      </Text>
    </Band>
  );
  return (
    <>
      <Show
        when={open() !== null}
        fallback={
          <Workspace>
            <Pane label={t().notebooks}>
              {statement()}
              {/* the ways to start as cards: what each makes, before it is chosen (a neutral sign: colour is for state
                  and the one main action) */}
              <Tiles
                variant="card"
                label={t().chooseStart}
                items={ways().map((way) => ({
                  icon: way.icon,
                  title: way.name,
                  meta: way.description || undefined,
                  stats: [{ icon: "files", label: t().pageCount({ count: way.pages.length }) }],
                  foot:
                    way.pages.length > 0
                      ? way.pages
                          .slice(0, 3)
                          .map((page) => page.title)
                          .join(" · ")
                      : undefined,
                  href: `/app/notebooks?template=${encodeURIComponent(way.id)}`,
                  onNavigate: () => choose(way.id, true),
                }))}
              />
            </Pane>
          </Workspace>
        }
      >
        <Workspace detail detailEmpty={{ icon: "notebook", text: t().chooseStart }}>
          <Pane.Split>
            <Pane label={t().notebooks} width={{ min: 320, default: 400 }}>
              {statement()}
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
      </Show>
      <NewNotebookDialog templates={props.templates} source={creating()} onClose={() => setCreating(null)} />
    </>
  );
}
