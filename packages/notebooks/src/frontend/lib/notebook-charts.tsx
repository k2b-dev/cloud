import {
  type CloudAiChartInput,
  type CloudAiChartTable,
  cloudAiChartMarkKey,
  cloudAiChartReferenceMark,
  cloudAiChartRenderOptions,
  cloudAiChartRows,
  cloudAiChartSchema,
  cloudAiChartTooltip,
} from "@k2b/cloud/ai/browser";
import { i18n } from "@k2b/stdlib";
import { CopyButton, IconButton, LocaleProvider, prepareChartSnapshot, toast } from "@k2b/ui";
import { type ChartTooltip, inspectChart } from "@k2b/ui/chart-inspection";
import { createSignal, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import { notebookChartTableHtml } from "../../lib/chart-blocks";
import { chartTableText } from "./chart-copy";

export const notebookChartMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      interactiveChart: "Interactive chart. Use arrow keys to read values and Escape to close.",
      showTable: "Show as table",
      copyData: "Copy data",
      copyFailed: "Could not copy the chart data. Try again or select the values in the table.",
    },
    de: {
      interactiveChart: "Interaktives Diagramm. Mit den Pfeiltasten Werte lesen, mit Escape schließen.",
      showTable: "Als Tabelle",
      copyData: "Daten kopieren",
      copyFailed: "Die Daten konnten nicht kopiert werden. Versuche es erneut oder markiere die Werte in der Tabelle.",
    },
  },
});

type Drawn = { tooltips: Map<string, ChartTooltip>; table: CloudAiChartTable };

let schema: ReturnType<typeof cloudAiChartSchema> | undefined;
const readInput = (figure: HTMLElement): CloudAiChartInput | null => {
  try {
    schema ??= cloudAiChartSchema();
    const result = schema.safeParse(JSON.parse(figure.dataset.chart ?? "null"));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

/** The same drawing as the server's (`renderNotebookChartFigure`), for the tooltips and table of its marks. */
const draw = (input: CloudAiChartInput, locale: string): Drawn => {
  const rows = cloudAiChartRows(input, locale);
  const snapshot = prepareChartSnapshot(cloudAiChartRenderOptions(input, locale, { legend: "outside" }), {
    key: ({ datum }) => cloudAiChartMarkKey(datum),
    tooltip: ({ datum }) => {
      const row = rows.add(datum);
      return cloudAiChartTooltip(rows.columns(), row);
    },
    reference: ({ datum }) => cloudAiChartReferenceMark(input, datum),
  });
  return { tooltips: new Map(snapshot.marks.map((mark) => [mark.key, mark.tooltip])), table: rows.table() };
};

function ChartControls(props: { figure: HTMLElement; viewport: HTMLElement; drawn: () => Drawn; locale: string; onView: () => void }) {
  const t = () => notebookChartMessages.resolve([props.locale]).t;
  const [table, setTable] = createSignal(false);
  let host: HTMLElement | undefined;
  const toggle = () => {
    const next = !table();
    props.onView();
    host?.remove();
    host = undefined;
    if (next) {
      // The note's own table markup, as the PDF prints it below the figure.
      const label = props.figure.querySelector(".notebook-book-chart__title")?.textContent ?? "";
      const scratch = document.createElement("div");
      scratch.innerHTML = notebookChartTableHtml(props.drawn().table, { label, className: "notebook-book-chart__table" });
      const element = scratch.firstElementChild;
      if (!(element instanceof HTMLElement)) return;
      // The table scrolls inside the chart's frame; as the drawing's tab stop is hidden, the scroll area takes it.
      element.tabIndex = 0;
      element.setAttribute("role", "region");
      element.setAttribute("aria-label", label);
      host = element;
      props.viewport.append(host);
      props.figure.dataset.view = "table";
    } else delete props.figure.dataset.view;
    setTable(next);
  };
  onCleanup(() => host?.remove());
  return (
    <LocaleProvider locale={props.locale}>
      <CopyButton
        text={chartTableText(props.drawn().table)}
        label={t().copyData}
        iconOnly
        size="sm"
        variant="ghost"
        onCopyError={() => toast.error(t().copyFailed)}
      />
      <IconButton label={t().showTable} size="sm" variant="ghost" aria-pressed={table()} onClick={toggle}>
        <Show when={table()} fallback={<i class="ti ti-table" aria-hidden="true" />}>
          <i class="ti ti-chart-bar" aria-hidden="true" />
        </Show>
      </IconButton>
    </LocaleProvider>
  );
}

/**
 * Adds the shared chart inspection (tooltips by pointer, tap and keyboard), the table view and Copy data to every
 * server-drawn `:::chart` figure under `root`. The server's SVG stays in place, and the controls fill the box the
 * frame reserves for them, so nothing moves. A figure without valid chart data keeps its static drawing, whose marks
 * still carry their values as SVG titles. Returns the cleanup that restores the static figures.
 */
export function enhanceNotebookCharts(root: HTMLElement, locale: string): () => void {
  const cleanups: (() => void)[] = [];
  for (const figure of root.querySelectorAll<HTMLElement>("figure.notebook-book-chart[data-chart]:not([data-enhanced])")) {
    const chart = figure.querySelector<HTMLElement>(".notebook-book-chart__viewport > .k2b-chart");
    const viewport = chart?.parentElement;
    const actions = figure.querySelector<HTMLElement>(".notebook-book-chart__actions");
    const kind = chart?.dataset.chartKind;
    const input = readInput(figure);
    if (!chart || !viewport || !actions || !input || kind !== input.kind) continue;
    let drawn: Drawn | undefined;
    // The drawing waits for the first tooltip, table or copy: a note can hold many charts nobody inspects.
    const lazy = () => (drawn ??= draw(input, locale));
    const t = notebookChartMessages.resolve([locale]).t;
    // The group is named by its title; the description tells how to read its values.
    chart.setAttribute("role", "group");
    chart.setAttribute("aria-label", figure.querySelector(".notebook-book-chart__title")?.textContent ?? "");
    chart.setAttribute("aria-description", t.interactiveChart);
    chart.dataset.interactive = "true";
    const inspection = inspectChart(chart, {
      kind: input.kind,
      format: ({ datum }) => lazy().tooltips.get(cloudAiChartMarkKey(datum)) ?? { rows: [] },
    });
    const dispose = render(
      () => <ChartControls figure={figure} viewport={viewport} drawn={lazy} locale={locale} onView={inspection.close} />,
      actions,
    );
    figure.dataset.enhanced = "true";
    cleanups.push(() => {
      dispose();
      inspection.destroy();
      // The inspector removes its geometry properties, but the browser keeps an empty style attribute.
      if (!chart.getAttribute("style")) chart.removeAttribute("style");
      for (const name of ["role", "aria-label", "aria-description", "data-interactive"]) chart.removeAttribute(name);
      for (const name of ["data-enhanced", "data-view"]) figure.removeAttribute(name);
    });
  }
  return () => cleanups.splice(0).forEach((cleanup) => cleanup());
}
