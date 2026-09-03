import { AppWorkspace, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount } from "solid-js";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { buildNoteUrl, buildTagPageUrl } from "../../../params";
import { BOOK_SNAPSHOT_EVENT, type BookMetadata } from "./book-state";
import { bookMessages } from "./messages";

export type BookTreeNode = { id: string; title: string; children: BookTreeNode[] };
export type BookNavigatorProps = {
  notebookId: string;
  notebookName: string;
  selectedNoteId: string | null;
  tree: BookTreeNode[];
  tags: { tag: string; count: number }[];
  activeTag?: string;
};

const expandedParents = (nodes: BookTreeNode[], selected: string | null): string[] => {
  for (const node of nodes) {
    if (node.id === selected) return [node.id];
    const children = expandedParents(node.children, selected);
    if (children.length) return [node.id, ...children];
  }
  return [];
};

/** Reading navigation deliberately has no dependency on the editor or inspector. */
export default function BookNavigator(props: BookNavigatorProps) {
  const locale = useLocale();
  const t = () => bookMessages.resolve([locale()]).t;
  const [state, setState] = createSignal(props);
  const [expanded, setExpanded] = createSignal<readonly string[]>(expandedParents(props.tree, props.selectedNoteId));
  onMount(() => {
    const update = (event: Event) => {
      const next = (event as CustomEvent<BookMetadata>).detail;
      setState({ ...props, ...next, activeTag: next.activeTag });
      setExpanded((current) => [...new Set([...current, ...expandedParents(next.tree, next.selectedNoteId)])]);
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
      <AppWorkspace.SidebarSection title={t().notes}>
        <AppWorkspace.NavTree
          ariaLabel={t().notes}
          selectedId={state().selectedNoteId}
          expandedIds={expanded()}
          onExpandedIdsChange={setExpanded}
        >
          {items(state().tree)}
        </AppWorkspace.NavTree>
        {state().tree.length === 0 && <Placeholder description={t().empty} />}
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
  return (
    <AppWorkspace.Sidebar resizable>
      <AppWorkspace.SidebarMobileTrigger label={state().notebookName} />
      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileBody>{navigation()}</AppWorkspace.SidebarMobileBody>
      </AppWorkspace.SidebarMobile>
      <AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarBody>{navigation()}</AppWorkspace.SidebarBody>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}
