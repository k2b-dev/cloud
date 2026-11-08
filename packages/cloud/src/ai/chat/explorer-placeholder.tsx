import { ChartExplorer, ChartFilterControls, type ChartSnapshot, useLocale } from "@k2b/ui";
import type { JSX } from "solid-js";
import type { CloudAiViewSummary } from "../view-block";
import { aiChatMessages } from "./messages";

type ExplorerSummary = Extract<CloudAiViewSummary, { view: "explorer" }>;
const HEIGHT = "18rem";
const emptySnapshot = (kind: ChartSnapshot["kind"]): ChartSnapshot => ({
  kind,
  svg: "",
  width: 480,
  height: 280,
  stretch: true,
  marks: [],
});
const hasControls = (summary: ExplorerSummary) => summary.step || summary.filter;

/** The frame of an explorer whose file is loading or unavailable, at the size the loaded explorer takes. */
export function ExplorerPlaceholder(props: { summary: ExplorerSummary; message: JSX.Element }) {
  const locale = useLocale();
  return (
    <ChartExplorer
      title={props.summary.title}
      description={props.summary.subtitle ? <span class="text-sm text-secondary">{props.summary.subtitle}</span> : undefined}
      height={HEIGHT}
      data={{ chart: emptySnapshot(props.summary.views[0]?.kind ?? "bar"), rows: [] }}
      columns={[{ id: "value", label: aiChatMessages(locale()).chartUnavailable, value: () => "" }]}
      charts={props.summary.views}
      chart={props.summary.views[0]?.id}
      controls={
        hasControls(props.summary) ? (
          <ChartFilterControls
            request={{ step: props.summary.step ? "0" : undefined }}
            displayedRequest={{}}
            steps={props.summary.step ? [{ key: "0", label: "" }] : undefined}
            series={props.summary.filter ? [{ key: "0", label: "", color: "var(--stdlib-chart-c1)" }] : undefined}
            compare={props.summary.compare}
            dimensionLabel={"\u00a0"}
            seriesLabel={"\u00a0"}
            disabled
            onRequest={() => {}}
          />
        ) : undefined
      }
      empty={props.message}
      renderDetails={false}
    />
  );
}
