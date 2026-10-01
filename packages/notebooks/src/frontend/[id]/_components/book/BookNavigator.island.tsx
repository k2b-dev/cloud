import { WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { AppWorkspace, createNavigation, type NavigationItem, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { buildNoteUrl, buildTagPageUrl } from "../../../params";
import { notebookWorkspaceMessages } from "../../messages";
import NavigationVisibilityControls from "../sidebar/NavigationVisibilityControls";
import {
  createNavigationHidden,
  followStoredNavigationHidden,
  NOTEBOOK_NAVIGATION_ID,
  setNavigationHidden,
} from "../sidebar/navigation-visibility";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata, requestBookNavigation } from "./book-state";
import { bookMessages } from "./messages";

export type BookTreeNode = { id: string; title: string; children: BookTreeNode[] };
export type BookNavigatorProps = {
  notebookId: string;
  notebookName: string;
  selectedNoteId: string | null;
  tree: BookTreeNode[];
  tags: { tag: string; count: number }[];
  activeTag?: string;
  canWrite?: boolean;
  locked?: boolean;
  /** The notebook navigation preference: a hidden contents list renders no page titles at all. */
  navigationHidden: boolean;
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
      setState({ ...props, ...next, activeTag: next.activeTag });
      if (opened) setExpanded((current) => [...new Set([...current, ...(ancestorIds(next.tree, next.selectedNoteId) ?? [])])]);
    };
    window.addEventListener(BOOK_SNAPSHOT_EVENT, update);
    onCleanup(() => window.removeEventListener(BOOK_SNAPSHOT_EVENT, update));
  });
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
  const navigation = () => (
    <>
      <AppWorkspace.SidebarItem href="/app/notebooks" icon="ti ti-library">
        {t().allNotebooks}
      </AppWorkspace.SidebarItem>
      {state().canWrite && (!state().selectedNoteId || state().locked) && (
        <AppWorkspace.SidebarItem
          href={withPresentationMode(
            state().selectedNoteId ? buildNoteUrl(props.notebookId, state().selectedNoteId!) : `/app/notebooks/${props.notebookId}`,
            "readonly",
          )}
          icon="ti ti-layout-sidebar"
        >
          {t().openWorkspace}
        </AppWorkspace.SidebarItem>
      )}
      <AppWorkspace.SidebarSection title={t().notes}>
        <Show
          when={state().tree.length > 0}
          fallback={<Placeholder variant="inline" align="left" icon="ti ti-file-text" description={t().empty} />}
        >
          <AppWorkspace.NavTree
            ariaLabel={t().notes}
            selectedId={state().selectedNoteId}
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
    active: state().selectedNoteId === node.id,
    // The sheet shows the same folds as the sidebar tree and hands its toggles back to this island.
    expanded: expanded().includes(node.id),
    children: node.children.map(noteEntry),
  });
  const mobileNavigation = createNavigation({
    items: () => [
      { id: "all", label: t().allNotebooks, href: "/app/notebooks", icon: "ti ti-library" },
      ...(state().canWrite && (!state().selectedNoteId || state().locked)
        ? [
            {
              id: "workspace",
              label: t().openWorkspace,
              icon: "ti ti-layout-sidebar",
              href: withPresentationMode(
                state().selectedNoteId ? buildNoteUrl(props.notebookId, state().selectedNoteId!) : `/app/notebooks/${props.notebookId}`,
                "readonly",
              ),
            },
          ]
        : []),
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
          <AppWorkspace.SidebarBody>{navigation()}</AppWorkspace.SidebarBody>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      {/* Book view has no editor toolbar, so it always offers the visible way back. */}
      <NavigationVisibilityControls hidden={navigationHidden()} showControl />
    </>
  );
}
