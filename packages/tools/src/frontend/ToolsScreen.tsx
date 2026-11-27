import { registerContextAwareCommand } from "@k2b/cloud/browser/commands";
import { V2WorkspaceNavigation } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import { type Action, Bar, Nav, type NavGroup, Pane, Path, Workspace } from "@k2b/ui/v2";
import { createEffect, createMemo, type JSX, onCleanup } from "solid-js";
import { createToolSearch, toolSearchMessages } from "./tool-search";
import { categoryOrder, resolveRegistry, type ToolCategory, type ToolId } from "./tools/registry";
import { toolsWorkspaceMessages } from "./tools-messages";

/**
 * The data colour of each category: a tool carries the sign of its category in the catalog, so the five areas read
 * apart at a glance. Colours from the shared data palette, none of them a state colour.
 */
export const categoryColor: Record<ToolCategory, string> = {
  images: "#c2410c",
  documents: "#1d4ed8",
  text: "#7c3aed",
  security: "#be123c",
  network: "#0f766e",
};

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
              // the overview is named by the sidebar's current entry; a tool says where it stands
              open() ? <Path label={t().appName} items={[{ label: t().appName, href: "/tools" }, { label: open()!.name }]} /> : undefined
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

/** The fixed column of a tool page: wide enough for a field and its hint, never stretched over a wide window. */
const toolColumn = { min: 320, default: 400 };

/**
 * A tool page in two columns, so a wide window holds its parts side by side instead of one form stretched over 1500 px.
 * A generator (password, UUID, text) leads with its result as the page's hero and keeps its options in a side column
 * at a fixed width; a converter (hash, encoding) takes what goes in at a fixed width on the left and shows the result
 * beside it. On the phone the two stand one under the other in this order: the result first for a generator.
 *
 * k2b-ui gap: a block of two columns that ends with its content. `Pane.Split` runs both columns and their seam to
 * the end of the page, so under a short result the column stays white to the bottom; the parts are made dense instead.
 */
export const ToolPanes = (props: {
  kind: "generator" | "converter";
  /** The name of the page's scroll position. */
  scrollKey: string;
  /** What goes in; `head` holds its kinds as tabs, such as symmetric and asymmetric encryption. */
  input: { label: string; head?: JSX.Element; children: JSX.Element };
  result: { label: string; status?: JSX.Element; children: JSX.Element };
}) =>
  props.kind === "generator" ? (
    <Pane.Split>
      <Pane label={props.result.label} scrollKey={props.scrollKey} status={props.result.status}>
        {props.result.children}
      </Pane>
      <Pane side label={props.input.label} head={props.input.head} width={toolColumn} scrollKey={`${props.scrollKey}-options`}>
        {props.input.children}
      </Pane>
    </Pane.Split>
  ) : (
    <Pane.Split>
      <Pane label={props.input.label} head={props.input.head} width={toolColumn} scrollKey={`${props.scrollKey}-input`}>
        {props.input.children}
      </Pane>
      <Pane label={props.result.label} scrollKey={props.scrollKey} status={props.result.status}>
        {props.result.children}
      </Pane>
    </Pane.Split>
  );
