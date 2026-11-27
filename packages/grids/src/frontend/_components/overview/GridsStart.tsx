import type { LinkNavigateEvent } from "@k2b/ssr/nav";
import { useLocale } from "@k2b/ui";
import { Pane, Text, Tiles, Workspace } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount } from "solid-js";
import { isServer } from "solid-js/web";
import { KIND_MARKS } from "../frame/kind-marks";
import { BASES_PAGE_PATH, withParam } from "./bases-query";
import CreateBaseDialog, { type BaseTemplate } from "./CreateBaseDialog";
import { overviewMessages } from "./messages";

/** One way to begin: a blank base, or a template with the tables it makes and the small table it shows on its card. */
export type StartWay = {
  id: string;
  name: string;
  icon: string;
  preview: { tables: number; columns: Array<{ name: string; align?: "end" }>; rows: string[][] } | null;
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
      <Pane label={t().getStarted} center>
        <Text type="lead">{t().firstBaseTitle}</Text>
        <Tiles
          variant="card"
          perRow={4}
          label={t().waysToStart}
          items={props.ways.map((way) => ({
            icon: way.icon,
            // each way makes a base: the base's mark, as the switcher shows it
            color: KIND_MARKS.base.color,
            title: way.name,
            href: withParam(BASES_PAGE_PATH, "new", way.id),
            onNavigate: (event: LinkNavigateEvent) => open(event, way.id),
            // under the name how many tables it makes (mockup empty-start-tiles v4)
            meta: way.preview ? t().tableCount({ count: way.preview.tables, formatted: number(way.preview.tables) }) : t().blankBaseFoot,
            // above the name the small table the template brings for its card; the blank base shows a table's sign
            preview: way.preview
              ? { table: { columns: way.preview.columns.map((column) => column.name), rows: way.preview.rows } }
              : { icon: "table" },
          }))}
        />
      </Pane>
      <CreateBaseDialog start={create()} templates={props.templates} onClose={close} />
    </Workspace>
  );
}
