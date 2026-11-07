import { isolateHistory } from "@codemirror/commands";
import { serializeGeoDocument } from "@k2b/cloud/geo/document";
import { type BlockPreviewOptions, type BlockPreviewResult, createBlockPreviews } from "@k2b/editor/markdown";
import { extractNotebookDirectiveRanges } from "@k2b/editor/markdown/lib/query-blocks";
import { notebookChartOptions } from "../../../lib/chart-options";
import { parseNotebookMapBlocks, renderNotebookMapFigure } from "../../../lib/map-blocks";
import { WORKSPACE_EVENT, type WorkspaceEventDetail } from "../../[id]/_components/sidebar/workspace-events";
import { enhanceNotebookMaps } from "../notebook-maps";
import { queryBlockMessages } from "./query-block-messages";

export type { BlockPreviewResult };

export function createQueryBlockPreviews(
  options: Omit<BlockPreviewOptions, "source" | "charts" | "messages" | "subscribe" | "placeholder" | "enhance"> & {
    notebookId: string;
    noteId: string;
  },
) {
  return createBlockPreviews({
    ...options,
    source: () => `${options.notebookId}/${options.noteId}`,
    charts: notebookChartOptions,
    messages: (locale) => queryBlockMessages.resolve([locale]).t,
    subscribe: ({ invalidate, active }) => {
      const handle = (raw: Event) => {
        const detail = (raw as CustomEvent<WorkspaceEventDetail>).detail;
        if (detail.event.notebookId !== options.notebookId || !active()) return;
        if (detail.event.type === "note.comments.changed" || detail.event.type === "note.favorite.changed") return;
        detail.cover(invalidate());
      };
      window.addEventListener(WORKSPACE_EVENT, handle);
      return () => window.removeEventListener(WORKSPACE_EVENT, handle);
    },
    placeholder: (block, source, locale, readOnly) => {
      const map = block.type === "map" ? (parseNotebookMapBlocks(source).blocks[0]?.document ?? null) : null;
      return map
        ? {
            key: source,
            estimatedHeight: map.route && !map.pins.length ? 66 + 30 + 10 + 240 : 66 + 30 + 10 + 36 + 10 + 320 + 10 + 176,
            render: (content, statusText) => {
              // The authorized canonical response alone mounts map requests/edit controls.
              content.innerHTML = renderNotebookMapFigure(map, { locale, notebookId: options.notebookId });
              if (!readOnly && (!map.route || map.pins.length)) {
                const search = document.createElement("div");
                search.className = "notebook-map__search-placeholder";
                search.setAttribute("aria-hidden", "true");
                content.querySelector(".notebook-map__body")?.prepend(search);
              }
              const status = content.querySelector<HTMLElement>(".notebook-map__placeholder");
              if (status) status.textContent = statusText;
            },
          }
        : null;
    },
    enhance: (content, view, range, locale, source) => {
      let currentSource = source;
      return enhanceNotebookMaps(
        content,
        locale,
        view.state.readOnly
          ? undefined
          : (_previous, next) => {
              if (view.state.readOnly) return false;
              const matches = extractNotebookDirectiveRanges(view.state.doc.toString()).filter(
                (block) => block.type === "map" && block.from === range.from && view.state.sliceDoc(block.from, block.to) === currentSource,
              );
              if (matches.length !== 1) return false;
              const block = matches[0]!;
              const insert = serializeGeoDocument(next);
              view.dispatch({
                changes: { from: block.from, to: block.to, insert },
                annotations: isolateHistory.of("full"),
                userEvent: "input.map",
              });
              currentSource = insert;
              return true;
            },
      );
    },
  });
}
