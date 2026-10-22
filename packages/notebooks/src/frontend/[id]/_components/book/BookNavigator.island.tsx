import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { AppWorkspace, createNavigation, type NavigationItem, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { buildGraphUrl, buildNoteUrl, buildTagPageUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import NavigationVisibilityControls from "../sidebar/NavigationVisibilityControls";
import {
  createNavigationHidden,
  followStoredNavigationHidden,
  NOTEBOOK_NAVIGATION_ID,
  setNavigationHidden,
} from "../sidebar/navigation-visibility";
import { createNotebookSwitcher } from "../sidebar/notebook-switcher";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata, requestBookNavigation } from "./book-state";
import { bookMessages } from "./messages";

export type BookTreeNode = { id: string; title: string; children: BookTreeNode[] };
export type BookNavigatorProps = {
  userId?: string;
  notebookId: string;
  notebookName: string;
  notebookIcon: string | null;
  selectedNoteId: string | null;
  tree: BookTreeNode[];
  tags: { tag: string; count: number }[];
  activeTag?: string;
  /** The current Book address; Write keeps its query (sidebar filters) and only switches the mode. */
  currentHref: string;
  canWrite?: boolean;
  locked?: boolean;
  /** The notebook navigation preference: a hidden contents list renders no page titles at all. */
  navigationHidden: boolean;
  /** The Book page this navigation stands beside, when it is its footer item; the open note then is not the current page. */
  current?: "graph";
  /** While the graph shows: the page it opened from, which its Links item keeps. */
  graphBack?: string;
};

/** The notes that contain the selected note, outermost first; `undefined` when it is not in the tree. */
const ancestorIds = (nodes: BookTreeNode[], selected: string | null): string[] | undefined => {
  for (const node of nodes) {
    if (node.id === selected) return [];
    const ancestors = ancestorIds(node.children, selected);
    if (ancestors) return [node.id, ...ancestors];
  }
};

/** Reading navigation deliberately has no dependency on the editor or inspector. */
export default function BookNavigator(props: BookNavigatorProps) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const workspaceText = () => notebookWorkspaceMessages.resolve([locale()]).t;
  const [state, setState] = createSignal(props);
  // Book view's contents list is the notebook navigation and follows the same hidden preference.
  const navigationHidden = createNavigationHidden(props.navigationHidden);
  followStoredNavigationHidden(navigationHidden);
  // A page load also unfolds the open note, so its sub-notes stay reachable before or without JavaScript.
  // After that, folding belongs to the reader: opening another note only reveals it, and its own
  // sub-notes and every later snapshot of the same note (live refreshes) leave the folds as they are.
  const [expanded, setExpanded] = createSignal<readonly string[]>(
    props.selectedNoteId ? [...(ancestorIds(props.tree, props.selectedNoteId) ?? []), props.selectedNoteId] : [],
  );
  onMount(() => {
    const update = (event: Event) => {
      const next = (event as CustomEvent<BookMetadata>).detail;
      const opened = next.selectedNoteId !== state().selectedNoteId;
      setState({ ...props, ...next, activeTag: next.activeTag, currentHref: next.href });
      if (opened) setExpanded((current) => [...new Set([...current, ...(ancestorIds(next.tree, next.selectedNoteId) ?? [])])]);
    };
    window.addEventListener(BOOK_SNAPSHOT_EVENT, update);
    onCleanup(() => window.removeEventListener(BOOK_SNAPSHOT_EVENT, update));
  });
  // The graph starts from the open note and keeps Book, so its links lead into Book; Close returns to the page it opened from.
  const graphHref = () =>
    buildGraphUrl(props.notebookId, state().selectedNoteId, "book", props.current === "graph" ? props.graphBack : state().currentHref);
  const currentNoteId = () => (props.current === "graph" ? null : state().selectedNoteId);
  const items = (nodes: BookTreeNode[]) =>
    nodes.map((node) => (
      <AppWorkspace.NavTree.Item
        id={node.id}
        label={node.title}
        icon="ti ti-file-text"
        href={withPresentationMode(buildNoteUrl(props.notebookId, node.id), "book")}
      >
        {node.children.length > 0 ? items(node.children) : undefined}
      </AppWorkspace.NavTree.Item>
    ));
  // A writer leaves Book from the top of the navigation: an unlocked note opens in Write, the
  // same target as the floating edit button; without a note or with a locked one, the read-only workspace.
  // Both entries fill the same slot, so switching between them never moves the contents list.
  const workspaceEntry = () => {
    const current = state();
    if (!current.canWrite) return null;
    if (current.selectedNoteId && !current.locked)
      return { label: t().write, icon: "ti ti-pencil", href: withPresentationMode(current.currentHref, "write") };
    return {
      label: t().openWorkspace,
      icon: "ti ti-layout-sidebar",
      href: withPresentationMode(
        current.selectedNoteId ? buildNoteUrl(props.notebookId, current.selectedNoteId) : `/app/notebooks/${props.notebookId}`,
        "readonly",
      ),
    };
  };
  const navigation = () => (
    <>
      <Show when={workspaceEntry()}>
        {(entry) => (
          <AppWorkspace.SidebarItem href={entry().href} icon={entry().icon}>
            {entry().label}
          </AppWorkspace.SidebarItem>
        )}
      </Show>
      <AppWorkspace.SidebarSection title={t().notes}>
        <Show
          when={state().tree.length > 0}
          fallback={<Placeholder variant="inline" align="left" icon="ti ti-file-text" description={t().empty} />}
        >
          <AppWorkspace.NavTree
            ariaLabel={t().notes}
            selectedId={currentNoteId()}
            expandedIds={expanded()}
            onExpandedIdsChange={setExpanded}
          >
            {items(state().tree)}
          </AppWorkspace.NavTree>
        </Show>
      </AppWorkspace.SidebarSection>
      {state().tags.length > 0 && (
        <AppWorkspace.SidebarSection title={t().tags}>
          <For each={state().tags}>
            {(item) => (
              <AppWorkspace.SidebarItem
                href={withPresentationMode(buildTagPageUrl(props.notebookId, item.tag), "book")}
                active={state().activeTag === item.tag}
                icon="ti ti-hash"
                meta={item.count}
              >
                {item.tag}
              </AppWorkspace.SidebarItem>
            )}
          </For>
        </AppWorkspace.SidebarSection>
      )}
    </>
  );
  // Reading pages open in the reading shell, so this island and the reader's folds outlive the sheet.
  // An action keeps that request outside the link's view transition; modified clicks still use the URL.
  const readingPage = (href: string) => ({ href, action: `open:${href}` });
  const openReadingPage = (href: string) => {
    if (!requestBookNavigation(href)) window.location.assign(href);
  };
  const noteEntry = (node: BookTreeNode): NavigationItem => ({
    id: `note:${node.id}`,
    label: node.title,
    icon: "ti ti-file-text",
    ...readingPage(withPresentationMode(buildNoteUrl(props.notebookId, node.id), "book")),
    active: currentNoteId() === node.id,
    // The sheet shows the same folds as the sidebar tree and hands its toggles back to this island.
    expanded: expanded().includes(node.id),
    children: node.children.map(noteEntry),
  });
  const switcher = createNotebookSwitcher(
    () => ({ id: props.notebookId, name: state().notebookName, icon: props.notebookIcon }),
    Boolean(props.userId),
  );
  const mobileNavigation = createNavigation({
    switcher,
    items: () => [
      ...[workspaceEntry()].flatMap((entry) => (entry ? [{ id: "workspace", ...entry }] : [])),
      { id: "notes", label: t().notes, children: state().tree.map(noteEntry) },
      ...(state().tags.length
        ? [
            {
              id: "tags",
              label: t().tags,
              children: state().tags.map((item) => ({
                id: `tag:${item.tag}`,
                label: item.tag,
                icon: "ti ti-hash",
                badge: item.count,
                active: state().activeTag === item.tag,
                ...readingPage(withPresentationMode(buildTagPageUrl(props.notebookId, item.tag), "book")),
              })),
            },
          ]
        : []),
      { id: "graph", label: workspaceText().noteLinks, icon: "ti ti-affiliate", href: graphHref(), active: props.current === "graph" },
    ],
    onAction: (action) => openReadingPage(action.slice("open:".length)),
    onExpandedChange: (id, open) => {
      const noteId = id.slice("note:".length);
      setExpanded((current) => (open ? [...new Set([...current, noteId])] : current.filter((entry) => entry !== noteId)));
    },
  });
  return (
    <>
      <WorkspaceNavigationProvider navigation={mobileNavigation} label={state().notebookName} />
      <AppWorkspace.Sidebar
        id={NOTEBOOK_NAVIGATION_ID}
        label={workspaceText().navigation}
        resizable
        hidden={navigationHidden()}
        onHiddenChange={setNavigationHidden}
      >
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarSwitcher {...switcher()} />
          <AppWorkspace.SidebarBody>{navigation()}</AppWorkspace.SidebarBody>
          {/* Marking the graph as the current page also names it, so the workspace head shows no way up beside it. */}
          <AppWorkspace.SidebarFooter class="notebook-sidebar-foot">
            <AppWorkspace.SidebarItem icon="ti ti-affiliate" href={graphHref()} active={props.current === "graph"}>
              {workspaceText().noteLinks}
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      {/* Book view has no editor toolbar, so it offers the visible way back; the graph's own toolbar holds the toggle. */}
      <NavigationVisibilityControls hidden={navigationHidden()} showControl={props.current !== "graph"} />
    </>
  );
}
