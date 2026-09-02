import { AppWorkspace, Placeholder, useLocale } from "@k2b/ui";
import { createSignal, For } from "solid-js";
import { withPresentationMode } from "../../../../lib/presentation-url";
import { buildNoteUrl, buildTagPageUrl } from "../../../params";
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
  const [expanded, setExpanded] = createSignal<readonly string[]>(expandedParents(props.tree, props.selectedNoteId));
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
          selectedId={props.selectedNoteId}
          expandedIds={expanded()}
          onExpandedIdsChange={setExpanded}
        >
          {items(props.tree)}
        </AppWorkspace.NavTree>
        {props.tree.length === 0 && <Placeholder description={t().empty} />}
      </AppWorkspace.SidebarSection>
      {props.tags.length > 0 && (
        <AppWorkspace.SidebarSection title={t().tags}>
          <For each={props.tags}>
            {(item) => (
              <AppWorkspace.SidebarItem
                href={withPresentationMode(buildTagPageUrl(props.notebookId, item.tag), "book")}
                active={props.activeTag === item.tag}
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
      <AppWorkspace.SidebarMobileTrigger label={props.notebookName} />
      <AppWorkspace.SidebarMobile>
        <AppWorkspace.SidebarMobileBody>{navigation()}</AppWorkspace.SidebarMobileBody>
      </AppWorkspace.SidebarMobile>
      <AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarBody>{navigation()}</AppWorkspace.SidebarBody>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
  );
}
