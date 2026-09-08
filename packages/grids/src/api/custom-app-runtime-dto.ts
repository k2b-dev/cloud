import { renderCustomAppMarkdown } from "../custom-apps/markdown-context";
import type { loadPublishedCustomAppPage } from "./custom-app-published-page";

/** Explicit reader projection: never expose drafts, compiled grants or workflow plans. */
export function projectCustomAppRuntimePage(data: NonNullable<Awaited<ReturnType<typeof loadPublishedCustomAppPage>>>) {
  return {
    id: data.shortId,
    name: data.definition.name,
    page: { id: data.page.id, title: data.page.title, parameters: data.page.parameters },
    navigation: data.definition.pages
      .filter((page) => page.navigation.visible)
      .map((page) => ({
        id: page.id,
        title: page.title,
        parameters: page.parameters,
      })),
    signedIn: data.signedIn,
    sidebarActions: data.sidebarActions,
    blocks: data.page.rows.flatMap((row) =>
      row.columns.flatMap((column) =>
        column.blocks.map((block) => ({
          id: block.id,
          type: block.type,
          title: block.title,
          markdown: block.type === "markdown" ? renderCustomAppMarkdown(block.markdown, data.markdownContext) : undefined,
          records: data.results.get(block.id),
          rowNavigate: block.type === "records" ? block.rowNavigate : undefined,
          metrics: data.metrics.get(block.id),
          chart: data.charts.get(block.id),
          record: data.pageRecords.get(block.id),
          editableFieldIds: block.type === "record" && data.recordUpdateEndpoints.has(block.id) ? block.editableFieldIds : undefined,
          documents: data.documents.get(block.id),
          html: data.renderedHtml.get(block.id),
          form: data.forms.get(block.id),
          actions: data.actions.get(block.id),
          rowActions: data.rowActions.get(block.id),
          recordsEndpoint: data.recordEndpoints.get(block.id),
          recordUpdateEndpoint: data.recordUpdateEndpoints.get(block.id),
          commentsEndpoint: data.commentEndpoints.get(block.id),
          scanner: data.scanners.has(block.id)
            ? {
                endpoint: data.scanners.get(block.id)!.endpoint,
                expectedRevision: data.scanners.get(block.id)!.state.expectedRevision,
                inputs: data.scanners
                  .get(block.id)!
                  .state.inputContract?.workflow.plan.inputs.filter(
                    (input) => input.name in (data.scanners.get(block.id)!.state.inputContract?.inputSources ?? {}),
                  ),
                inputSources: data.scanners.get(block.id)!.state.inputContract?.inputSources,
              }
            : undefined,
        })),
      ),
    ),
  };
}
