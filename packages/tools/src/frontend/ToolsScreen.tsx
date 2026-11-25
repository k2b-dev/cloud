import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { type Action, Bar, Nav, type NavGroup, Path, Text, Workspace } from "@k2b/ui/v2";
import { createEffect, createMemo, type JSX, onCleanup } from "solid-js";
import { createToolSearch, toolSearchMessages } from "./tool-search";
import { categoryOrder, resolveRegistry, type ToolId } from "./tools/registry";
import { toolsWorkspaceMessages } from "./tools-messages";

/** v2 names Tabler icons without the `ti ti-` classes the registry keeps for v1 surfaces (search, commands). */
export const toolIcon = (icon: string) => icon.replace(/^ti ti-/, "");

/**
 * The frame of every Tools page on v2: the catalog by category in the sidebar (with the overview and the tool search),
 * and a head that says where the page stands. Each tool screen passes its panes as children.
 */
export default function ToolsScreen(props: {
  /** The open tool; none on the overview. */
  tool?: ToolId;
  /** The head's end: the tool's own deeds, or the overview's search. */
  end?: JSX.Element;
  /** The page's main deed, mirrored for the phone. */
  primary?: Action;
  children: JSX.Element;
}) {
  const locale = useLocale();
  const t = () => toolsWorkspaceMessages.resolve([locale()]).t;
  const search = createToolSearch();
  const registry = createMemo(() => resolveRegistry(locale()));
  const open = () => (props.tool ? registry().toolById(props.tool) : undefined);
  createEffect(() =>
    onCleanup(
      registerContextAwareCommand({
        id: "tools.search",
        title: toolSearchMessages.resolve([locale()]).t.searchTools,
        description: toolSearchMessages.resolve([locale()]).t.searchTools,
        icon: "ti ti-search",
        shortcut: "mod+shift+k",
        action: search,
      }),
    ),
  );
  const groups = (): NavGroup[] => [
    {
      items: [
        { label: t().overview, icon: "layout-grid", href: "/tools", current: !props.tool },
        { label: toolSearchMessages.resolve([locale()]).t.searchTools, icon: "search", onClick: () => void search() },
      ],
    },
    ...categoryOrder.map((category) => ({
      label: registry().categories[category].label,
      items: registry()
        .tools.filter((tool) => tool.category === category)
        .map((tool) => ({ label: tool.name, icon: toolIcon(tool.icon), href: `/tools/${tool.id}`, current: tool.id === props.tool })),
    })),
  ];
  return (
    <>
      <V2WorkspaceNavigation label={open()?.name ?? t().appName} groups={groups()} />
      <Workspace
        sidebar={<Nav title={t().appName} icon="tools" groups={groups()} />}
        head={
          <Bar
            start={
              open() ? (
                <Path label={t().appName} items={[{ label: t().appName, href: "/tools" }, { label: open()!.name }]} />
              ) : (
                <Text type="body">{t().appName}</Text>
              )
            }
            end={props.end}
          />
        }
        primary={props.primary}
      >
        {props.children}
      </Workspace>
    </>
  );
}
