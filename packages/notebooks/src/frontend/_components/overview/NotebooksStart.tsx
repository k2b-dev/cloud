import { useLocale } from "@k2b/ui";
import { Pane, Text, type TilePreview, Tiles, Workspace } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount } from "solid-js";
import { notebooksPageMessages } from "../../messages";
import { createNoteCommands } from "../../note-commands";
import NewNotebookDialog, { type NewNotebookSource, type TemplateSummary } from "./NewNotebookDialog";

/** One page a way to start makes: its title and the page it stands under. */
export type StartPage = { title: string; parent: string | null };
/** A template on the start page, with the pages it makes and what its card previews of them. */
export type StartTemplate = TemplateSummary & { pages: readonly StartPage[]; preview?: TilePreview };

/** The blank notebook's place in the address. */
export const BLANK = "blank";

/** How many templates stand beside the blank notebook; the others stay in the dialog's choice of template. */
export const START_TEMPLATES = 3;

/** A template's sign as the v2 icon name. */
const sign = (icon: string) => icon.replace(/^ti ti-/, "");

/** The address of the start page with the dialog open for one way to start, or without it. */
const startUrl = (id: string | null) => {
  const url = new URL(window.location.href);
  if (id === null) url.searchParams.delete("new");
  else url.searchParams.set("new", id);
  return url;
};

/**
 * Notebooks for a person who has none yet. Everyone else never sees this page: `/app/notebooks` opens the notebook
 * they used last.
 *
 * Screen brief: a person opens Notebooks for the first time. They need, in this order: (1) the invitation to make their
 * first notebook, (2) the ways to start, a blank notebook or one of three templates, (3) what each makes
 * before they choose it: a glance of it and how many pages. Nothing else is on the page: no sidebar, no switcher
 * (Valentin: no nav, a few nice tiles in the middle). Eye path: the line, then the four cards from the blank one
 * on. A card opens the new-notebook dialog with its way to start; the dialog is in the address (`?new=`), so a reload
 * shows it again and back closes it. The fourth template and any later one stay in the dialog's choice of template.
 * On the phone the cards stand under each other from the top.
 *
 * Each card previews what its way makes across its top (mockup empty-start-tiles v4): the template's first table, or
 * the blank notebook's welcome page, from the templates themselves.
 */
export default function NotebooksStart(props: {
  templates: readonly StartTemplate[];
  blankPages: readonly StartPage[];
  blankPreview?: TilePreview;
  open?: string | null;
}) {
  createNoteCommands();
  const locale = useLocale();
  const t = () => notebooksPageMessages.resolve([locale()]).t;
  const sourceOf = (id: string | null | undefined): NewNotebookSource | null =>
    id === BLANK
      ? { kind: "blank" }
      : props.templates.some((template) => template.id === id)
        ? { kind: "template", templateId: id ?? undefined }
        : null;
  // the open dialog comes from the address, so the server's page already holds it
  const [creating, setCreating] = createSignal<NewNotebookSource | null>(sourceOf(props.open));
  // whether this page put the dialog into the history: then closing it goes back, so back never reopens it
  let pushed = false;
  const open = (id: string) => {
    setCreating(sourceOf(id));
    window.history.pushState(window.history.state, "", startUrl(id));
    pushed = true;
  };
  const close = () => {
    setCreating(null);
    if (pushed) window.history.back();
    else window.history.replaceState(window.history.state, "", startUrl(null));
    pushed = false;
  };
  onMount(() => {
    const follow = () => {
      pushed = false;
      setCreating(sourceOf(new URL(window.location.href).searchParams.get("new")));
    };
    window.addEventListener("popstate", follow);
    onCleanup(() => window.removeEventListener("popstate", follow));
  });
  const ways = () => [
    { id: BLANK, name: t().blankNotebook, icon: "notebook", pages: props.blankPages, preview: props.blankPreview },
    ...props.templates.slice(0, START_TEMPLATES).map((template) => ({
      id: template.id,
      name: template.name,
      icon: sign(template.icon),
      pages: template.pages,
      preview: template.preview,
    })),
  ];
  return (
    <>
      <Workspace>
        <Pane label={t().notebooks} center>
          <Text type="lead">{t().firstNotebook}</Text>
          {/* each card in Notebooks' colour: it is the one thing to do here */}
          <Tiles
            variant="card"
            perRow={4}
            label={t().chooseStart}
            items={ways().map((way) => ({
              key: way.id,
              icon: way.icon,
              color: "var(--k2-app)",
              title: way.name,
              meta: t().pageCount({ count: way.pages.length }),
              preview: way.preview,
              href: `/app/notebooks?new=${encodeURIComponent(way.id)}`,
              onNavigate: () => open(way.id),
            }))}
          />
        </Pane>
      </Workspace>
      <NewNotebookDialog templates={props.templates} source={creating()} onClose={close} />
    </>
  );
}
