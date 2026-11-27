import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Pane, Text, Tiles, Workspace } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { BASES_PAGE_PATH, withParam } from "./bases-query";
import CreateBaseDialog, { type BaseTemplate } from "./CreateBaseDialog";
import { overviewMessages } from "./messages";

/** One way to begin: a blank base, or a template with the tables it makes and its main table's first columns. */
export type StartWay = {
  id: string;
  name: string;
  icon: string;
  preview: { tables: number; table: string; columns: string[] } | null;
};

export type GridsStartProps = {
  /** Blank first, then the templates the page offers. */
  ways: StartWay[];
  /** Every template, for the dialog's choice. */
  templates: BaseTemplate[];
  /** The way the dialog opens with (`?new=`), or null while it is closed. */
  create: string | null;
};

/**
 * Grids before the first base: no sidebar and no switcher, only the question and four ways in the middle of the page.
 * A way opens the dialog that creates the base, in the address (`?new=`), with its name filled in.
 */
export default function GridsStart(props: GridsStartProps) {
  const locale = useLocale();
  const t = () => overviewMessages.resolve([locale()]).t;
  const here = () => (isServer ? BASES_PAGE_PATH : `${location.pathname}${location.search}`);
  const [create, setCreate] = createSignal(props.create);
  const open = (event: LinkNavigateEvent, way: string) => {
    event.push(withParam(here(), "new", way), { scroll: "manual" });
    setCreate(way);
  };
  const close = () => {
    history.replaceState(history.state, "", withParam(here(), "new", null));
    setCreate(null);
  };
  onMount(() => {
    const restore = () => setCreate(new URL(location.href).searchParams.get("new"));
    addEventListener("popstate", restore);
    onCleanup(() => removeEventListener("popstate", restore));
  });
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);

  return (
    <Workspace>
      {/* k2b-ui gap (#4477): `Pane center` puts the block in the middle of the page */}
      <Pane label={t().getStarted}>
        <Text type="lead">{t().firstBaseQuestion}</Text>
        {/* k2b-ui gap (#4477): `perRow={4}` keeps the four ways in one row */}
        <Tiles
          variant="card"
          label={t().waysToStart}
          items={props.ways.map((way) => ({
            icon: way.icon,
            color: "var(--k2-app)",
            title: way.name,
            href: withParam(BASES_PAGE_PATH, "new", way.id),
            onNavigate: (event: LinkNavigateEvent) => open(event, way.id),
            ...(way.preview
              ? {
                  stats: [{ icon: "table", label: t().tableCount({ count: way.preview.tables, formatted: number(way.preview.tables) }) }],
                  foot: `${way.preview.table} · ${way.preview.columns.join(", ")}`,
                }
              : { foot: t().blankBaseFoot }),
          }))}
        />
      </Pane>
      <CreateBaseDialog start={create()} templates={props.templates} onClose={close} />
    </Workspace>
  );
}
