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
  images: "#0e7490",
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

/**
 * A tool page as one block from the top: the result and what goes in stand one under the other in one pane, and the
 * page ends after them. No column of options beside a result that stays short, so no white half beside or below it.
 * A generator (password, UUID, colour) leads with its result as the page's hero, its options follow; a converter (hash,
 * encoding) and a long text lead with what goes in, its result follows. The phone keeps the same order.
 *
 * Each part brings its own `Section`s: what goes in keeps the reading measure (`measure`), so a field never runs over
 * 1500 px, and so does the result, so a value and its copy stay together; the password keeps the whole width as the
 * figure of the page.
 *
 * k2b-ui gap: waits #4360 (`Section.Columns`): in a wide window the result and the options could stand side by side
 * in this one block, each ending with its content. When #4360 lands, the two parts go into `<Section.Columns>` in
 * this order, so the phone keeps the result first.
 */
export const ToolPane = (props: {
  /** What stands first: the result (a password, a colour) or what goes in (a text to hash, the options of a long text). */
  lead: "result" | "input";
  /** The name of the page's scroll position. */
  scrollKey: string;
  /** The name of the pane. */
  label: string;
  /** Kinds of the tool as tabs, such as symmetric and asymmetric encryption. */
  head?: JSX.Element;
  /** What goes in, as `Section`s with `measure`. */
  input: JSX.Element;
  /** The result, as `Section`s. */
  result: JSX.Element;
}) => (
  <Pane label={props.label} head={props.head} scrollKey={props.scrollKey}>
    {props.lead === "result" ? (
      <>
        {props.result}
        {props.input}
      </>
    ) : (
      <>
        {props.input}
        {props.result}
      </>
    )}
  </Pane>
);
