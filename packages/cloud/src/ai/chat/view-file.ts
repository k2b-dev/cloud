import {
  CLOUD_AI_VIEW_MAX_BYTES,
  type CloudAiView,
  type CloudAiViewSummary,
  type CloudViewDescription,
  cloudAiViewSummary,
  isAiViewFile,
  parseCloudAiView,
} from "../view-block";
import { cloudAiViewDescription } from "../view-description";

/** Loads a view file with the viewer's access and validates it again: a file is untrusted whoever wrote it. */
export async function loadView(
  url: string,
  path: string,
  summary: CloudAiViewSummary,
  signal: AbortSignal,
): Promise<CloudViewDescription | null> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok || !isAiViewFile({ path, origin: response.headers.get("X-Cloud-Ai-File-Origin") ?? "" })) return null;
    const blob = await response.blob();
    if (blob.size > CLOUD_AI_VIEW_MAX_BYTES) return null;
    const view = parseCloudAiView(JSON.parse(await blob.text()));
    return view && matches(view, summary) ? cloudAiViewDescription(view) : null;
  } catch {
    return null;
  }
}

type Heading = { title: string; subtitle?: string };
const sameHeading = (a: Heading, b: Heading | undefined) => a.title === b?.title && a.subtitle === b.subtitle;

/**
 * Whether a loaded file still has everything its summary reserved: kinds, headings, layout and the linked cursor. A
 * changed file shows unavailable instead of moving views or linking charts its summary did not.
 */
const matches = (view: CloudAiView, summary: CloudAiViewSummary) => {
  if (view.view === "table") return summary.view === "table" && sameHeading(view, summary);
  const loaded = cloudAiViewSummary(view);
  // A record must keep the field count and the labels and value lengths that sized its viewport.
  if (loaded.view === "details")
    return (
      summary.view === "details" &&
      sameHeading(loaded, summary) &&
      loaded.items === summary.items &&
      JSON.stringify(loaded.fields) === JSON.stringify(summary.fields)
    );
  // A stats file must keep every tile's label and parts, which set the tile heights its summary reserved.
  if (loaded.view === "stats")
    return summary.view === "stats" && sameHeading(loaded, summary) && JSON.stringify(loaded.items) === JSON.stringify(summary.items);
  if (loaded.view === "explorer")
    return (
      summary.view === "explorer" &&
      sameHeading(loaded, summary) &&
      loaded.step === summary.step &&
      loaded.filter === summary.filter &&
      loaded.compare === summary.compare &&
      JSON.stringify(loaded.views) === JSON.stringify(summary.views)
    );
  if (loaded.view === "chart") return summary.view === "chart" && loaded.kind === summary.kind && sameHeading(loaded, summary);
  return (
    loaded.view === "group" &&
    summary.view === "group" &&
    sameHeading(loaded, summary) &&
    loaded.linkX === summary.linkX &&
    loaded.layout === summary.layout &&
    loaded.charts.length === summary.charts.length &&
    loaded.charts.every((chart, index) => chart.kind === summary.charts[index]?.kind && sameHeading(chart, summary.charts[index]))
  );
};
