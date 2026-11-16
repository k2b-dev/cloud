import { gustavLine } from "../gustav-view-blocks";
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
    // `view=1`: Cloud names the view's references for this reader as it reads the file (`view-names.ts`).
    const response = await fetch(`${url}${url.includes("?") ? "&" : "?"}view=1`, { signal });
    if (!response.ok || !isAiViewFile({ path, origin: response.headers.get("X-Cloud-Ai-File-Origin") ?? "" })) return null;
    const blob = await response.blob();
    if (blob.size > CLOUD_AI_VIEW_MAX_BYTES) return null;
    const view = parseCloudAiView(JSON.parse(await blob.text()));
    return view && matches(view, summary) ? gustavLines(cloudAiViewDescription(view)) : null;
  } catch {
    return null;
  }
}

/** Loads a view file without a summary from the chat, such as one opened in a tab; it takes its summary from itself. */
export async function loadViewFile(
  url: string,
  path: string,
  signal: AbortSignal,
): Promise<{ summary: CloudAiViewSummary; view: CloudViewDescription } | null> {
  try {
    const response = await fetch(url, { signal });
    if (!response.ok || !isAiViewFile({ path, origin: response.headers.get("X-Cloud-Ai-File-Origin") ?? "" })) return null;
    const blob = await response.blob();
    if (blob.size > CLOUD_AI_VIEW_MAX_BYTES) return null;
    const view = parseCloudAiView(JSON.parse(await blob.text()));
    return view ? { summary: cloudAiViewSummary(view), view: cloudAiViewDescription(view) } : null;
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
  // A record must keep the field count and the labels and value lengths that sized its viewport. A reference's text is
  // its title for this reader, named as the file is read (`view=1`), so only its label and kind are reserved.
  if (loaded.view === "details") {
    const reserved = (fields: typeof loaded.fields) => JSON.stringify(fields.map((field) => (field.ref ? { ...field, chars: 0 } : field)));
    return (
      summary.view === "details" &&
      sameHeading(loaded, summary) &&
      loaded.items === summary.items &&
      reserved(loaded.fields) === reserved(summary.fields)
    );
  }
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

/** A view file is Gustav's: its lines draw as his chart tool's do, straight with a hollow point on every value. */
const gustavLines = (description: CloudViewDescription): CloudViewDescription => {
  if ("kind" in description) return gustavLine(description);
  if (description.block === "group") return { ...description, charts: description.charts.map(gustavLine) };
  return description;
};
