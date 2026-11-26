import { enhanceNotebookCharts } from "@k2b/editor/markdown/notebook-charts";
import { useLocale } from "@k2b/ui";
import { createEffect, For, onCleanup } from "solid-js";
import { notebookChartOptions } from "../../../../lib/chart-options";
import type { DiffRow } from "./version-history";

/**
 * A saved version as the reader sees it: the note's rendered Markdown with its charts. It stands inside the
 * version pane's `Canvas`, so it keeps the note's own typography.
 */
export const VersionContent = (props: { html: string }) => {
  const locale = useLocale();
  return (
    <div class="mx-auto w-full max-w-4xl p-4">
      <article
        class="notebook-book-content"
        innerHTML={props.html}
        ref={(element) =>
          // User effects run after the render effect that writes the version's HTML.
          createEffect(() => {
            void props.html;
            onCleanup(enhanceNotebookCharts(element, locale(), notebookChartOptions));
          })
        }
      />
    </div>
  );
};

/** The line diff between two versions: old and new line numbers, the sign, and the line. */
export const VersionDiff = (props: { rows: DiffRow[] }) => (
  <div class="min-w-max font-mono text-xs leading-5">
    <For each={props.rows}>
      {(row) => (
        <div
          class={`grid grid-cols-[2.5rem_2.5rem_1.5rem_minmax(20rem,1fr)] ${
            row.kind === "added"
              ? "bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300"
              : row.kind === "removed"
                ? "bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300"
                : "text-secondary"
          }`}
          data-diff={row.kind}
        >
          <span class="select-none px-1 text-right text-dimmed tabular-nums">{row.oldLine ?? ""}</span>
          <span class="select-none px-1 text-right text-dimmed tabular-nums">{row.newLine ?? ""}</span>
          <span class="select-none text-center text-dimmed">{row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}</span>
          <span class="whitespace-pre-wrap break-words pr-3">{row.value || " "}</span>
        </div>
      )}
    </For>
  </div>
);
